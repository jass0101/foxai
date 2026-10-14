import { packager } from '@electron/packager'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// Product identity: exe name, file description, product name, company and path.
const NAME = 'Fox AI'

const paths = await packager({
  dir: '.',
  name: NAME,
  appVersion: pkg.version,
  platform: 'win32',
  arch: 'x64',
  out: 'dist',
  overwrite: true,
  asar: true,
  prune: true,
  icon: 'build/icon.ico',
  appCopyright: 'Copyright (C) 2026',
  // Keep repo-only files out of the asar: build output, editor config, this
  // script, and git internals (a .git folder would bloat the package).
  ignore: [
    /^\/dist($|\/)/,
    /^\/\.vscode($|\/)/,
    /^\/package\.mjs$/,
    /^\/\.git($|\/)/,
    /^\/\.gitignore$/
  ],
  win32metadata: {
    CompanyName: NAME,
    ProductName: NAME,
    FileDescription: NAME,
    OriginalFilename: `${NAME}.exe`,
    InternalName: NAME
  }
})

console.log('packaged:\n' + paths.join('\n'))
