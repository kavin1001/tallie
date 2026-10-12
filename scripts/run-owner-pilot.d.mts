type Configuration = Record<string, string | undefined>;

export function localOwnerPilotConfiguration(
  role: string,
  config: Configuration,
  platform?: Configuration,
): { command: string[]; cwd: string; environment: Configuration };
export function readLocalOwnerPilotSettings(path?: string): Record<string, string>;
