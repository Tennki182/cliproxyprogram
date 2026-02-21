import type { QueryExecResult } from 'sql.js';

export function rowToObject<T>(result: QueryExecResult[]): T | null {
  if (result.length === 0 || result[0].values.length === 0) {
    return null;
  }
  const columns = result[0].columns;
  const values = result[0].values[0];
  const obj: Record<string, unknown> = {};
  columns.forEach((col: string, i: number) => {
    obj[col] = values[i];
  });
  return obj as unknown as T;
}

export function rowsToObjects<T>(result: QueryExecResult[]): T[] {
  if (result.length === 0 || result[0].values.length === 0) {
    return [];
  }
  const columns = result[0].columns;
  const values = result[0].values;
  return values.map((row: unknown[]) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col: string, i: number) => {
      obj[col] = row[i];
    });
    return obj as unknown as T;
  });
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
