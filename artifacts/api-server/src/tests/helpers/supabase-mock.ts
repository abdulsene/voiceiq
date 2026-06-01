/**
 * Supabase client mock for Sprint 2 provisioning + reconciliation tests.
 *
 * Implements the fluent-chain shape used by the production code:
 *   sb.from('table').select('cols').eq('col', val).maybeSingle()
 *   sb.from('table').update({...}, { count: 'exact' }).eq(...).in(...)
 *   sb.from('table').insert({...})
 *
 * Responses are programmable per (table, op) pair and dequeued FIFO so
 * a single test can stub a sequence of reads/writes (e.g. read-then-
 * update inside markFailure). When the queue empties, falls back to a
 * configurable default response.
 *
 * Each call is recorded into `mock.calls` so assertions can verify
 * exactly which columns were written, which filters were applied,
 * and the order of operations.
 *
 * Wired into the system under test via the existing test override
 * hooks:
 *   _setSupabaseClientForTests(mock.client as unknown as <SupabaseClient>);
 */

export interface SupabaseResponseLike {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
}

export type SupabaseOp = 'select' | 'update' | 'insert' | 'delete';

export interface RecordedSupabaseCall {
  table: string;
  op: SupabaseOp;
  cols?: string;
  values?: unknown;
  options?: unknown;
  filters: Array<{ kind: string; args: unknown[] }>;
}

export interface SupabaseMockHandle {
  /** Pass this to `_setSupabaseClientForTests`. */
  client: unknown;
  /** Every operation recorded, in execution order. */
  calls: RecordedSupabaseCall[];
  /**
   * Stub a sequence of responses for a (table, op). Calls dequeue in
   * insertion order; subsequent calls past the end fall back to the
   * default response.
   */
  setResponses(table: string, op: SupabaseOp, ...responses: SupabaseResponseLike[]): void;
  /** Default response for any (table, op) without a specific stub. */
  setDefaultResponse(response: SupabaseResponseLike): void;
  /** Wipe both the recorded calls and the response queues. */
  reset(): void;
}

export function createSupabaseMock(): SupabaseMockHandle {
  const calls: RecordedSupabaseCall[] = [];
  const responseQueues: Map<string, SupabaseResponseLike[]> = new Map();
  let defaultResponse: SupabaseResponseLike = { data: null, error: null, count: 0 };

  const keyOf = (table: string, op: SupabaseOp) => `${table}:${op}`;

  function resolveResponse(call: RecordedSupabaseCall): SupabaseResponseLike {
    const queue = responseQueues.get(keyOf(call.table, call.op));
    if (queue && queue.length > 0) {
      return queue.shift()!;
    }
    return defaultResponse;
  }

  class QueryBuilder implements PromiseLike<SupabaseResponseLike> {
    private op: SupabaseOp = 'select';
    private cols?: string;
    private values?: unknown;
    private options?: unknown;
    private filters: Array<{ kind: string; args: unknown[] }> = [];

    constructor(private readonly table: string) {}

    select(cols: string): this {
      this.op = 'select';
      this.cols = cols;
      return this;
    }

    update(values: unknown, options?: unknown): this {
      this.op = 'update';
      this.values = values;
      this.options = options;
      return this;
    }

    insert(values: unknown): this {
      this.op = 'insert';
      this.values = values;
      return this;
    }

    delete(): this {
      this.op = 'delete';
      return this;
    }

    eq(col: string, val: unknown): this {
      this.filters.push({ kind: 'eq', args: [col, val] });
      return this;
    }

    in(col: string, vals: unknown[]): this {
      this.filters.push({ kind: 'in', args: [col, vals] });
      return this;
    }

    not(col: string, op: string, val: unknown): this {
      this.filters.push({ kind: 'not', args: [col, op, val] });
      return this;
    }

    maybeSingle(): Promise<SupabaseResponseLike> {
      return this.executeOnce();
    }

    single(): Promise<SupabaseResponseLike> {
      return this.executeOnce();
    }

    // Thenable so `await sb.from('x').update(...).eq(...).in(...)` works.
    then<TResult1 = SupabaseResponseLike, TResult2 = never>(
      onfulfilled?:
        | ((value: SupabaseResponseLike) => TResult1 | PromiseLike<TResult1>)
        | null
        | undefined,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
    ): PromiseLike<TResult1 | TResult2> {
      return this.executeOnce().then(onfulfilled, onrejected);
    }

    private executed = false;
    private cachedResult: Promise<SupabaseResponseLike> | null = null;
    private executeOnce(): Promise<SupabaseResponseLike> {
      // Builder is one-shot; multiple awaits / multiple terminals
      // resolve to the same recorded call + response.
      if (this.executed && this.cachedResult) return this.cachedResult;
      this.executed = true;
      const call: RecordedSupabaseCall = {
        table: this.table,
        op: this.op,
        cols: this.cols,
        values: this.values,
        options: this.options,
        filters: this.filters,
      };
      calls.push(call);
      this.cachedResult = Promise.resolve(resolveResponse(call));
      return this.cachedResult;
    }
  }

  const client = {
    from: (table: string) => new QueryBuilder(table),
  };

  return {
    client,
    calls,
    setResponses(table, op, ...responses) {
      responseQueues.set(keyOf(table, op), [...responses]);
    },
    setDefaultResponse(response) {
      defaultResponse = response;
    },
    reset() {
      calls.length = 0;
      responseQueues.clear();
      defaultResponse = { data: null, error: null, count: 0 };
    },
  };
}
