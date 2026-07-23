export function escapePosixShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function pipeTextToCommand(stdinData: string, command: string): string {
  return `printf '%s' ${escapePosixShellArg(stdinData)} | ${command}`;
}
