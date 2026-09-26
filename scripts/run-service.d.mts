type Configuration = Record<string, string | undefined>;

export function appOrigin(config: Configuration, platform?: Configuration): string | undefined;
export function serviceConfiguration(
  service: string,
  config: Configuration,
  platform?: Configuration,
): { command: string[]; cwd: string; environment: Configuration };
