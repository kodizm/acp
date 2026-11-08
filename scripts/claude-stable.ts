/**
 * Keeps the Claude Code CLI the image installs on the official `stable` channel.
 *
 * The CLI is never pinned directly: the image reads `config.claudeAgentSdk` from the published
 * package and installs the CLI binary that SDK release bundles. So following `stable` means moving
 * that pin, together with the matching dev dependency, to the SDK release whose `claudeCodeVersion`
 * equals the stable CLI. The `claude-stable-bump` workflow runs this daily:
 *
 *   bun run scripts/claude-stable.ts resolve
 *   bun run scripts/claude-stable.ts apply --sdk <sdk> --cli <cli>
 *
 * Both commands print `key=value` lines, which the workflow appends to `$GITHUB_OUTPUT`. A
 * non-zero exit means the sources contradict each other and nothing may be changed.
 */

import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { parseArgs } from 'node:util'

const run = promisify(execFile)

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'
const PACKAGE_NAME = '@kodizm/acp'
const STABLE_FILE_URL = 'https://downloads.claude.ai/claude-code-releases/stable'
const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags'
const PLAIN_VERSION = /^(\d+)\.(\d+)\.(\d+)$/

/** Name of the bump workflow; its changelog entries carry it, which is how its releases are told apart. */
export const BOT_MARKER = 'claude-stable-bump'

/** One published SDK version and the CLI version it bundles, as `npm view` reports them. */
export interface SdkRelease {
  readonly version: string
  readonly claudeCodeVersion: string
}

export interface DecideInput {
  /** Body of the stable pointer file on downloads.claude.ai. */
  readonly bucket: string
  /** `dist-tags.stable` of `@anthropic-ai/claude-code` on npm. */
  readonly npmTag: string
  readonly releases: readonly SdkRelease[]
  /** The SDK version `config.claudeAgentSdk` holds today. */
  readonly pinned: string
}

/**
 * What the daily run should do: `bump` moves the pin, `unchanged` has nothing to do, and `wait`
 * leaves the pin alone for a reason a later run can clear (or a person has to look at).
 */
export type Resolution =
  | { readonly kind: 'bump'; readonly cli: string; readonly sdk: string; readonly previousSdk: string }
  | { readonly kind: 'unchanged'; readonly cli: string; readonly sdk: string }
  | { readonly kind: 'wait'; readonly cli: string; readonly reason: string }

export interface ChangelogEntry {
  readonly version: string
  /** UTC date, `YYYY-MM-DD`. */
  readonly date: string
  readonly sdk: string
  readonly cli: string
  readonly previousSdk: string
}

interface PackageShape {
  version: string
  config: { claudeAgentSdk: string }
  devDependencies: Record<string, string>
  [key: string]: unknown
}

/**
 * Decide what the stable channel asks of the pin.
 *
 * The SDK is found by exact lookup on `claudeCodeVersion`, never by arithmetic on the patch
 * number: some numbers were never published (2.1.313 and 0.3.313 do not exist), so a shifted
 * number can name a package that is not there. The pin only ever moves forward: when `stable` is
 * re-pointed at an older release the run waits, because the bridge was built and tested against
 * the newer SDK.
 *
 * @throws Error when a pointer is not a version, or the two pointers name different releases.
 */
export function decide(input: DecideInput): Resolution {
  // 1. The two stable pointers are moved together by Anthropic; a mismatch means something is off.
  const bucket = input.bucket.trim()
  const npmTag = input.npmTag.trim()

  assertVersion(bucket, 'The stable file')
  assertVersion(npmTag, 'The npm stable tag')

  if (bucket !== npmTag) {
    throw new Error(`The stable pointers disagree: the stable file says ${bucket}, the npm tag says ${npmTag}.`)
  }

  // 2. Exact lookup. Pre-releases are never followed.
  const sdk = highestVersion(
    input.releases
      .filter((release) => release.claudeCodeVersion === bucket && PLAIN_VERSION.test(release.version))
      .map((release) => release.version),
  )

  if (sdk === null) {
    return { kind: 'wait', cli: bucket, reason: `No SDK release bundles Claude Code ${bucket} yet.` }
  }

  // 3. Compare with the pin.
  if (sdk === input.pinned) {
    return { kind: 'unchanged', cli: bucket, sdk }
  }

  if (compareVersions(sdk, input.pinned) < 0) {
    return {
      kind: 'wait',
      cli: bucket,
      reason: `Stable (${bucket}, SDK ${sdk}) is older than the pin (${input.pinned}); the pin never moves back.`,
    }
  }

  return { kind: 'bump', cli: bucket, sdk, previousSdk: input.pinned }
}

/**
 * Read the JSON `npm view <package>@<range> version claudeCodeVersion --json` prints.
 *
 * npm prints an array for a range and a bare object for a single match, and nothing at all for
 * no match.
 */
export function parseReleases(raw: string): SdkRelease[] {
  if (raw.trim() === '') {
    return []
  }

  const parsed: unknown = JSON.parse(raw)
  const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed]

  return entries.flatMap((entry) => {
    const { version, claudeCodeVersion } = (entry ?? {}) as Partial<SdkRelease>

    return typeof version === 'string' && typeof claudeCodeVersion === 'string' ? [{ version, claudeCodeVersion }] : []
  })
}

/** The next patch release of `version`: `0.9.1` becomes `0.9.2`. */
export function nextPatch(version: string): string {
  const match = PLAIN_VERSION.exec(version)

  if (match === null) {
    throw new Error(`Cannot read the version ${JSON.stringify(version)} as major.minor.patch.`)
  }

  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

/**
 * Move the package version and both SDK pins in one pass, keeping the formatting npm writes.
 *
 * @throws Error when either pin is missing, since a bump that moves only one of them is the
 *         mismatch `package-pin.test.ts` exists to catch.
 */
export function bumpPackage(text: string, sdk: string, version: string): string {
  const pkg = JSON.parse(text) as PackageShape

  if (typeof pkg.config?.claudeAgentSdk !== 'string') {
    throw new Error('package.json has no config.claudeAgentSdk to move.')
  }

  if (typeof pkg.devDependencies?.[SDK_PACKAGE] !== 'string') {
    throw new Error(`package.json has no ${SDK_PACKAGE} dev dependency to move.`)
  }

  pkg.version = version
  pkg.config.claudeAgentSdk = sdk
  pkg.devDependencies[SDK_PACKAGE] = sdk

  return `${JSON.stringify(pkg, null, 2)}\n`
}

/** Insert the release above the newest one, keeping the header paragraph where it is. */
export function addChangelogEntry(text: string, entry: ChangelogEntry): string {
  const anchor = text.search(/^## \[/m)

  if (anchor === -1) {
    throw new Error('The changelog has no release heading to insert above.')
  }

  const block = [
    `## [${entry.version}] - ${entry.date}`,
    '',
    '### Changed',
    '',
    '- **Claude Code CLI follows the stable channel.** The SDK pin moves',
    `  from ${entry.previousSdk} to ${entry.sdk}, so the image installs Claude Code ${entry.cli},`,
    `  the version the stable channel serves. Opened by the \`${BOT_MARKER}\` workflow.`,
    '',
    '',
  ].join('\n')

  return `${text.slice(0, anchor)}${block}${text.slice(anchor)}`
}

/**
 * Whether the changelog section of `version` was written by the bump workflow.
 *
 * The daily run uses it to publish only releases it made itself: a version a person bumped by hand
 * and has not tagged yet is theirs to release, and the image repository follows only these too.
 */
export function isBotRelease(changelog: string, version: string): boolean {
  const heading = `## [${version}]`
  const start = changelog.indexOf(heading)

  if (start === -1) {
    return false
  }

  const next = changelog.indexOf('\n## [', start + heading.length)
  const section = changelog.slice(start, next === -1 ? undefined : next)

  return section.includes(BOT_MARKER)
}

function assertVersion(value: string, label: string): void {
  if (!PLAIN_VERSION.test(value)) {
    throw new Error(`${label} does not hold a version: ${JSON.stringify(value)}.`)
  }
}

function compareVersions(left: string, right: string): number {
  const a = (PLAIN_VERSION.exec(left) ?? []).slice(1).map(Number)
  const b = (PLAIN_VERSION.exec(right) ?? []).slice(1).map(Number)

  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)

    if (difference !== 0) {
      return difference
    }
  }

  return 0
}

function highestVersion(versions: readonly string[]): string | null {
  return versions.reduce<string | null>(
    (best, candidate) => (best === null || compareVersions(candidate, best) > 0 ? candidate : best),
    null,
  )
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`GET ${url} answered ${response.status}.`)
  }

  return response.text()
}

async function readSources(): Promise<Omit<DecideInput, 'pinned'>> {
  const [bucket, tags, view] = await Promise.all([
    fetchText(STABLE_FILE_URL),
    fetchText(DIST_TAGS_URL),
    run('npm', ['view', `${SDK_PACKAGE}@>=0.3.0`, 'version', 'claudeCodeVersion', '--json'], {
      maxBuffer: 32 * 1024 * 1024,
    }),
  ])

  const npmTag = (JSON.parse(tags) as { stable?: string }).stable ?? ''

  return { bucket, npmTag, releases: parseReleases(view.stdout) }
}

function printOutputs(outputs: Record<string, string>): void {
  for (const [key, value] of Object.entries(outputs)) {
    process.stdout.write(`${key}=${value}\n`)
  }
}

/**
 * Whether npm already has `version` of the package.
 *
 * Only an E404 answers no. Any other failure (network, registry) is rethrown: reading a hiccup as
 * "unpublished" would start a duplicate publish.
 */
async function isPublished(version: string): Promise<boolean> {
  try {
    const { stdout } = await run('npm', ['view', `${PACKAGE_NAME}@${version}`, 'version'])

    return stdout.trim() === version
  } catch (error) {
    if (String((error as { stderr?: unknown }).stderr ?? '').includes('E404')) {
      return false
    }

    throw error
  }
}

async function resolveCommand(): Promise<void> {
  const packageText = await readFile(new URL('../package.json', import.meta.url), 'utf8')
  const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  const pkg = JSON.parse(packageText) as PackageShape

  const resolution = decide({ ...(await readSources()), pinned: pkg.config.claudeAgentSdk })

  if (resolution.kind === 'bump') {
    printOutputs({
      kind: resolution.kind,
      cli: resolution.cli,
      sdk: resolution.sdk,
      version: nextPatch(pkg.version),
      recover: 'false',
    })

    return
  }

  // 1. A bump that merged but never reached npm leaves the pin current and its release missing.
  // 2. Only a release this workflow wrote is recovered; a version a person bumped is theirs.
  const recover = isBotRelease(changelog, pkg.version) && !(await isPublished(pkg.version))

  printOutputs({
    ...(resolution.kind === 'wait'
      ? { kind: resolution.kind, cli: resolution.cli, reason: resolution.reason }
      : { kind: resolution.kind, cli: resolution.cli, sdk: resolution.sdk }),
    version: pkg.version,
    recover: String(recover),
  })
}

async function applyCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { sdk: { type: 'string' }, cli: { type: 'string' } } })

  if (values.sdk === undefined || values.cli === undefined) {
    throw new Error('apply needs --sdk and --cli.')
  }

  const packageUrl = new URL('../package.json', import.meta.url)
  const changelogUrl = new URL('../CHANGELOG.md', import.meta.url)

  const packageText = await readFile(packageUrl, 'utf8')
  const pkg = JSON.parse(packageText) as PackageShape
  const version = nextPatch(pkg.version)

  await writeFile(packageUrl, bumpPackage(packageText, values.sdk, version))
  await writeFile(
    changelogUrl,
    addChangelogEntry(await readFile(changelogUrl, 'utf8'), {
      version,
      date: new Date().toISOString().slice(0, 10),
      sdk: values.sdk,
      cli: values.cli,
      previousSdk: pkg.config.claudeAgentSdk,
    }),
  )

  printOutputs({ version })
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv

  try {
    if (command === 'resolve') {
      await resolveCommand()
    } else if (command === 'apply') {
      await applyCommand(rest)
    } else {
      throw new Error('Usage: claude-stable.ts resolve | apply --sdk <version> --cli <version>')
    }

    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))

    return 1
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2))
}
