// roster-link — turn a roster JSON file into a verified-room invite link, from the command line.
// The SAME core the web "Set up your room" page uses (parseRoomConfig → buildVerifiedRoster), so a
// link minted here opens identically in a browser. Handy for authoring a big roster in version
// control, scripting invites, or generating links OFFLINE without the web UI (the link is the room;
// nothing is registered on a server). With --passphrase the roster is SEALED (encrypted) into the
// link — share the secret out of band; the link itself reveals nothing to the host or a passer-by.
//
// Run it via the bundling runner (Node can't import the extensionless TS modules directly):
//   node scripts/roster-link.mjs <roster.json> [--passphrase] [--base URL] [--room ID] [--days N]
//   npm run roster-link -- <roster.json> [...flags]
//
// PASSPHRASE HANDLING (Layer-2 sealing) — the secret is NEVER taken from argv, so it can't leak
// into your shell history or `ps`. Two safe sources, in priority order:
//   1. env:    ROSTER_PASSPHRASE=… node scripts/roster-link.mjs roster.json   (good for scripting)
//   2. prompt: pass `--passphrase` (bare) and it reads the secret with NO ECHO (or from piped stdin)
// The link is printed to STDOUT (pipeable); notes/prompts go to STDERR.

import { readFileSync } from 'node:fs'
import { parseRoomConfig } from '../src/demo/roomConfig'
import { freshRoom } from '../src/demo/roomName'
import { buildVerifiedRoster } from '../src/core/joinGateRuntime'
import { withGateFragment } from '../src/core/joinGateLink'
import { normalizeRoom } from '../src/core/transport'

interface Args {
  file?: string
  base: string
  /** `--passphrase`/`-p` is a BARE flag — it never carries the secret (no argv leak); it just asks
   *  to seal, and the secret comes from $ROSTER_PASSPHRASE or a no-echo prompt. */
  askPassphrase: boolean
  room?: string
  days: number
}

function parseArgs(argv: readonly string[]): Args {
  const a: Args = { base: 'https://kibitz.chat', askPassphrase: false, days: 7 }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--base') a.base = argv[++i] ?? a.base
    else if (v === '--passphrase' || v === '-p') a.askPassphrase = true
    else if (v === '--room') a.room = argv[++i]
    else if (v === '--days') a.days = Number(argv[++i]) || a.days
    else if (v === '-h' || v === '--help') a.file = undefined
    else if (!v.startsWith('-') && !a.file) a.file = v
  }
  return a
}

/** Read a passphrase without it ever touching argv. From piped stdin (non-TTY), or an interactive
 *  NO-ECHO prompt (raw mode, nothing rendered). Returns '' if nothing was entered. */
function readPassphrase(): Promise<string> {
  const stdin = process.stdin
  // Piped (e.g. `printf %s "$secret" | …`): read it all, strip a trailing newline.
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      stdin.on('data', (c: Buffer) => chunks.push(c))
      stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')))
      stdin.resume()
    })
  }
  // Interactive: prompt on stderr, read keystrokes with echo OFF.
  return new Promise((resolve) => {
    process.stderr.write('Passphrase (hidden): ')
    let input = ''
    stdin.setRawMode(true)
    stdin.resume()
    const onData = (buf: Buffer) => {
      const s = buf.toString('utf8')
      if (s === '\n' || s === '\r' || s === '\u0004') {
        stdin.setRawMode(false)
        stdin.pause()
        stdin.removeListener('data', onData)
        process.stderr.write('\n')
        resolve(input)
      } else if (s === '\u0003') {
        process.stderr.write('\n')
        process.exit(130) // ctrl-c
      } else if (s === '\u007f' || s === '\b') {
        input = input.slice(0, -1)
      } else {
        input += s
      }
    }
    stdin.on('data', onData)
  })
}

const USAGE = `roster-link — make a verified-room invite link from a roster JSON file

  node scripts/roster-link.mjs <roster.json> [flags]
  npm run roster-link -- <roster.json> [flags]

Flags:
  --base <url>        site origin (default https://kibitz.chat)
  --passphrase, -p    seal the roster — reads the secret from $ROSTER_PASSPHRASE or a
                      no-echo prompt (NEVER from the command line, so it can't leak)
  --room <id>         use a fixed room id (default: a fresh un-guessable one)
  --days <n>          link/roster validity in days (default 7)

Roster file shape (see scripts/roster.sample.json):
  { "access": "verified", "clientId": "…apps.googleusercontent.com",
    "description": "...", "invitees": [ { "method": "signin", "email": "a@x.com" }, ... ] }
`

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.file) {
    process.stderr.write(USAGE)
    process.exit(process.argv.includes('-h') || process.argv.includes('--help') ? 0 : 2)
  }

  const parsed = parseRoomConfig(readFileSync(args.file, 'utf8'))
  if (!parsed.ok) {
    process.stderr.write(`error: ${parsed.error}\n`)
    process.exit(1)
  }
  const cfg = parsed.config

  // Resolve the passphrase WITHOUT ever reading it from argv: $ROSTER_PASSPHRASE first (scripting),
  // else a no-echo prompt if --passphrase was asked. Trim to match the web (CreatePage/PassphraseGate
  // both .trim()), so a CLI-sealed link unlocks with the same typed secret in the browser.
  let passphrase = (process.env.ROSTER_PASSPHRASE ?? '').trim()
  if (!passphrase && args.askPassphrase) passphrase = (await readPassphrase()).trim()
  const sealed = passphrase.length > 0
  if (args.askPassphrase && !sealed) process.stderr.write('note:    no passphrase entered — the link is NOT sealed.\n')

  const room = args.room ? normalizeRoom(args.room) : freshRoom()
  const base = `${args.base.replace(/\/+$/, '')}/#${room}`
  const desc = cfg.description?.slice(0, 80)
  const withDesc = (link: string) => (desc ? withGateFragment(link, new URLSearchParams({ d: desc })) : link)

  let link: string
  if (cfg.access === 'open') {
    link = withDesc(base) // an open room is just the room id (+ optional description)
  } else {
    if (!cfg.clientId) {
      process.stderr.write('error: a verified room needs a "clientId" (your Google sign-in app id)\n')
      process.exit(1)
    }
    const exp = Math.floor(Date.now() / 1000) + args.days * 86400
    const { roomLink } = await buildVerifiedRoster(base, room, cfg.invitees ?? [], cfg.clientId, exp, sealed ? passphrase : undefined)
    link = withDesc(roomLink)
  }

  // STDOUT: just the link (pipeable). STDERR: context for a human.
  process.stderr.write(`room:    ${room}\n`)
  process.stderr.write(`access:  ${cfg.access}${sealed ? ' (passphrase-sealed)' : ''}\n`)
  if (cfg.access === 'verified') process.stderr.write(`expires: in ${args.days} day(s)\n`)
  if (sealed) process.stderr.write(`note:    share the passphrase out of band — it is NOT in the link.\n`)
  process.stdout.write(link + '\n')
}

void main()
