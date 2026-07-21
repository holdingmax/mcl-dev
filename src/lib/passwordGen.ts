// Password generation + strength validation
// Policy: min 10 chars, at least one lowercase, uppercase, digit, and symbol.

const LOWER   = 'abcdefghijkmnopqrstuvwxyz'          // no 'l'
const UPPER   = 'ABCDEFGHJKLMNPQRSTUVWXYZ'            // no 'I', 'O'
const DIGITS  = '23456789'                            // no '0', '1'
const SYMBOLS = '!@#$%&*?+-='

const ALL = LOWER + UPPER + DIGITS + SYMBOLS

function pick(set: string): string {
  const arr = new Uint32Array(1)
  crypto.getRandomValues(arr)
  return set[arr[0] % set.length]
}

function shuffle(str: string): string {
  const arr = str.split('')
  for (let i = arr.length - 1; i > 0; i--) {
    const rand = new Uint32Array(1)
    crypto.getRandomValues(rand)
    const j = rand[0] % (i + 1)
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr.join('')
}

export function generateSecurePassword(length = 12): string {
  if (length < 10) length = 10
  // Guarantee one of each category, then fill the rest from the full alphabet.
  const required = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)]
  const rest: string[] = []
  for (let i = 0; i < length - required.length; i++) rest.push(pick(ALL))
  return shuffle(required.concat(rest).join(''))
}

export interface PasswordStrengthResult {
  valid: boolean
  errors: string[]
}

export function validatePasswordStrength(password: string): PasswordStrengthResult {
  const errors: string[] = []
  if (password.length < 10) errors.push('Mínimo 10 caracteres')
  if (!/[a-z]/.test(password)) errors.push('Al menos una minúscula')
  if (!/[A-Z]/.test(password)) errors.push('Al menos una mayúscula')
  if (!/[0-9]/.test(password)) errors.push('Al menos un número')
  if (!/[^A-Za-z0-9]/.test(password)) errors.push('Al menos un símbolo')
  return { valid: errors.length === 0, errors }
}
