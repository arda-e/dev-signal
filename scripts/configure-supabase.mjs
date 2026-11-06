import {readFile, writeFile} from 'node:fs/promises'

const input = process.argv[2]
if (!input)
  throw new Error(
    'Usage: npm run configure:supabase -- https://PROJECT_REF.supabase.co',
  )
const url = new URL(input)
if (
  url.protocol !== 'https:' ||
  !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) ||
  url.username ||
  url.password ||
  url.port ||
  !['', '/'].includes(url.pathname) ||
  url.search ||
  url.hash
)
  throw new Error(
    'Provide only an HTTPS Supabase project origin, without credentials or a path.',
  )
const path = new URL('../devvit.json', import.meta.url)
const config = JSON.parse(await readFile(path, 'utf8'))
config.permissions.http.domains = [
  ...config.permissions.http.domains.filter(
    domain => !domain.endsWith('.supabase.co'),
  ),
  url.hostname,
]
config.settings.global['supabase-project-url'].defaultValue = url.origin
await writeFile(path, `${JSON.stringify(config, null, 2)}\n`)
console.log(
  `Configured ${url.hostname}. Domain approval is still required; no credentials were written.`,
)
