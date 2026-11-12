// CI passes unset parameters as empty strings, so an empty CLI value falls back to the env value.
export function cliOrEnv(cli: string | undefined, env: string): string {
  return cli?.trim() || env
}
