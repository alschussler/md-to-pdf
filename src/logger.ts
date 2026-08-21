const isTTY = process.stdout.isTTY === true;

const c = {
  reset:   isTTY ? '\x1B[0m'  : '',
  bold:    isTTY ? '\x1B[1m'  : '',
  dim:     isTTY ? '\x1B[2m'  : '',
  green:   isTTY ? '\x1B[32m' : '',
  red:     isTTY ? '\x1B[31m' : '',
  yellow:  isTTY ? '\x1B[33m' : '',
  cyan:    isTTY ? '\x1B[36m' : '',
};

export const log = {
  info:    (msg: string) => console.log(msg),
  success: (msg: string) => console.log(`${c.green}${msg}${c.reset}`),
  error:   (msg: string) => console.error(`${c.red}${msg}${c.reset}`),
  warn:    (msg: string) => console.warn(`${c.yellow}${msg}${c.reset}`),
  dim:     (msg: string) => console.log(`${c.dim}${msg}${c.reset}`),
  section: (msg: string) => console.log(`\n${c.bold}${c.cyan}${msg}${c.reset}`),
  step:    (msg: string) => console.log(`  ${c.cyan}»${c.reset} ${msg}`),
};
