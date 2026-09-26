export interface AvatarProps {
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  /** Keep decorative when the adjacent text already names this person. */
  decorative?: boolean;
}

const tones = ['rose', 'sage', 'clay', 'lilac', 'sand', 'sky'] as const;

function nameTone(name: string): (typeof tones)[number] {
  let hash = 0;
  for (const character of name.normalize('NFC')) {
    hash = (Math.imul(31, hash) + (character.codePointAt(0) ?? 0)) | 0;
  }
  return tones[(hash >>> 0) % tones.length] ?? 'sage';
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return '?';
  const first = Array.from(words[0] ?? '')[0] ?? '';
  const last = words.length > 1 ? (Array.from(words.at(-1) ?? '')[0] ?? '') : '';
  return `${first}${last}`.toLocaleUpperCase('en-US');
}

export function Avatar({ name, size = 'md', className = '', decorative = true }: AvatarProps) {
  return (
    <span
      className={`ui-avatar ui-avatar--${nameTone(name)} ui-avatar--${size} ${className}`}
      aria-hidden={decorative ? true : undefined}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : name}
    >
      {initials(name)}
    </span>
  );
}
