import fs from 'fs'
import path from 'path'

const rootPath = process.cwd()
const distPath = path.join(rootPath, './dist')

if (fs.existsSync(distPath)) {
  fs.rmSync(distPath, { recursive: true, force: true })
}
