/** Strip ServiceNow prefixes from identifiers. */
export function stripPrefix(s: string): string {
  return s.replace(/^u_/, '').replace(/^x_[a-z0-9]+_[a-z0-9]+_/, '');
}

export function toCamel(s: string): string {
  return s.replace(/[_-](.)/g, (_, c) => c.toUpperCase());
}

export function toPascal(s: string): string {
  const c = toCamel(s);
  return c.charAt(0).toUpperCase() + c.slice(1);
}

export function toKebab(s: string): string {
  return s.replace(/_/g, '-').toLowerCase();
}

export function sanitizePackage(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
}

export function sanitizeArtifactId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
}

export function pluralize(s: string): string {
  if (/(s|x|z|ch|sh)$/.test(s)) return s + 'es';
  if (/[^aeiou]y$/.test(s)) return s.slice(0, -1) + 'ies';
  return s + 's';
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
