const fs = require('fs')
const path = require('path')
const home = process.env.USERPROFILE || process.env.HOME
const cfgPath = path.join(home, '.config', 'configstore', 'firebase-tools.json')
console.log('Path:', cfgPath)
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
const hasTokens = cfg.tokens ? true : false
const hasRefresh = cfg.tokens && cfg.tokens.refresh_token ? true : false
console.log('Has tokens:', hasTokens)
console.log('Has refresh_token:', hasRefresh)
if (hasRefresh) {
  console.log('REFRESH_TOKEN=' + cfg.tokens.refresh_token.slice(0, 20) + '...')
}
