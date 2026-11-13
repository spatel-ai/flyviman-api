/** How a document is named in alerts (the web has its own copy for screens). */
const LABELS: Record<string, string> = {
  'OPERATOR:AOC': 'Air operator certificate',
  'OPERATOR:INSURANCE': 'Insurance',
  'OPERATOR:REGISTRATION': 'Company registration',
  'AIRCRAFT:REGISTRATION': 'Certificate of registration',
  'AIRCRAFT:AIRWORTHINESS': 'Certificate of airworthiness',
  'AIRCRAFT:INSURANCE': 'Insurance',
};

export function documentLabel(kind: string, type: string): string {
  return LABELS[`${kind}:${type}`] ?? 'Document';
}
