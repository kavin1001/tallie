type Configuration = Record<string, string | undefined>;

export function localConnectionConfiguration(
  role: string,
  config: Configuration,
  platform?: Configuration,
): { command: string[]; cwd: string; environment: Configuration };
export function readLocalConnectionSettings(path?: string): Record<string, string>;
