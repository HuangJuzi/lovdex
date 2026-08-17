// Service definitions for the Lovdex supervisor.
// Pure data; imported by supervisor.mjs. Lives in supervisor/, so '..' is the lovdex/ parent.
import { fileURLToPath, URL } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url)) // /.../lovdex/

export const services = [
  {
    name: 'backend',
    cwd: resolve(root, 'backend'),
    dev:  { cmd: 'npm', args: ['run', 'dev'] },
    prod: { cmd: 'npm', args: ['run', 'dev'] },
    port: 3188,
    needsBuild: false,
    distDir: resolve(root, 'backend', 'dist-server'),
  },
  {
    name: 'frontend',
    cwd: resolve(root, 'web'),
    dev:  { cmd: 'npm', args: ['run', 'dev'] },
    prod: { cmd: 'npm', args: ['run', 'preview', '--', '--host', '0.0.0.0', '--port', '5188', '--strictPort'] },
    port: 5188,
    needsBuild: true,
    distDir: resolve(root, 'web', 'dist'),
  },
]
