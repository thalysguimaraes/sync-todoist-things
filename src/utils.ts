import { TaskFingerprint } from './types';

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '');
}

export function calculateSimilarity(str1: string, str2: string): number {
  const norm1 = normalizeText(str1);
  const norm2 = normalizeText(str2);
  
  if (norm1 === norm2) return 1;
  
  const longer = norm1.length > norm2.length ? norm1 : norm2;
  const shorter = norm1.length > norm2.length ? norm2 : norm1;
  
  if (longer.length === 0) return 1.0;
  
  const editDistance = getEditDistance(shorter, longer);
  return (longer.length - editDistance) / longer.length;
}

function getEditDistance(s1: string, s2: string): number {
  const costs: number[] = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}

export function isSimilarEnough(str1: string, str2: string, threshold: number = 0.85): boolean {
  return calculateSimilarity(str1, str2) >= threshold;
}

export async function generateContentHash(content: string, notes?: string): Promise<string> {
  const combined = `${normalizeText(content)}|${normalizeText(notes || '')}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(combined);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex.substring(0, 8);
}

export async function generateRobustHash(title: string, notes?: string, due?: string): Promise<string> {
  const normalized = {
    title: normalizeText(title),
    notes: normalizeText(notes || ''),
    due: due || ''
  };
  
  const combined = `${normalized.title}|${normalized.notes}|${normalized.due}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(combined);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex.substring(0, 12); // Longer hash for better uniqueness
}

export function generateTitleVariations(title: string): string[] {
  const normalized = normalizeText(title);
  const variations = [
    normalized,
    title.trim(), // Original with just whitespace trimmed
    title.trim().toLowerCase(), // Case normalized
    normalized.replace(/\s+/g, ''), // No spaces
  ];
  
  // Remove duplicates
  return [...new Set(variations)];
}

export async function createTaskFingerprint(title: string, notes?: string, due?: string): Promise<TaskFingerprint> {
  const primaryHash = await generateRobustHash(title, notes, due);
  const titleVariations = generateTitleVariations(title);
  const fuzzySearchable = normalizeText(title);
  
  return {
    primaryHash,
    titleVariations,
    fuzzySearchable
  };
}



export function extractThingsIdFromNotes(notes: string): string | null {
  const match = notes.match(/\[things-id:([^\]]+)\]/);
  return match ? match[1] : null;
}

export function extractTodoistIdFromDescription(description: string): string | null {
  const match = description.match(/\[todoist-id:([^\]]+)\]/);
  return match ? match[1] : null;
}

export function addThingsIdToNotes(notes: string, thingsId: string): string {
  const cleanedNotes = notes.replace(/\[things-id:[^\]]+\]/g, '').trim();
  return `${cleanedNotes}\n\n[things-id:${thingsId}]`.trim();
}

export function addTodoistIdToDescription(description: string, todoistId: string): string {
  const cleanedDesc = description.replace(/\[todoist-id:[^\]]+\]/g, '').trim();
  return `${cleanedDesc}\n\n[todoist-id:${todoistId}]`.trim();
}

export async function acquireSyncLock(
  kv: KVNamespace,
  timeout: number = 30000
): Promise<string | null> {
  const lockKey = 'sync:lock';
  const now = Date.now();

  const existingLock = await kv.get(lockKey);
  if (existingLock) {
    const lockData = JSON.parse(existingLock);
    if (now - lockData.timestamp < timeout) {
      return null;
    }
  }

  const token = crypto.randomUUID();
  await kv.put(
    lockKey,
    JSON.stringify({ timestamp: now, token }),
    { expirationTtl: 60 }
  );
  return token;
}

export async function releaseSyncLock(
  kv: KVNamespace,
  token: string
): Promise<boolean> {
  const lockKey = 'sync:lock';
  const existingLock = await kv.get(lockKey);
  if (!existingLock) return false;

  const lockData = JSON.parse(existingLock);
  if (lockData.token !== token) {
    return false;
  }

  await kv.delete(lockKey);
  return true;
}