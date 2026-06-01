/**
 * Twilio client mock for Sprint 2 provisioning + reconciliation tests.
 *
 * Duck-typed to satisfy the surface area used by the production code
 * (twilio-provisioning.ts + twilio-reconciliation.ts) without dragging
 * in the real SDK's type tree. Mocks are configurable per-test and
 * record every call so assertions can verify exactly what the
 * production code did (or did not do).
 *
 * Wired into the system under test via the existing test override
 * hooks:
 *   _setTwilioClientForTests(mock.client as unknown as <TwilioClient>);
 */

export interface AvailableNumberStub {
  phoneNumber: string;
}

export interface ListedNumberStub {
  sid: string;
  phoneNumber: string;
  dateCreated: Date;
}

export type PurchaseBehavior =
  | { kind: 'success'; sid?: string; phoneNumber?: string }
  | { kind: 'throw'; error: Error }
  | { kind: 'malformed'; response: unknown };

export type ReleaseBehavior =
  | { kind: 'success' }
  | { kind: 'throw'; error: Error };

export interface TwilioMockOptions {
  /** Map of area code → array of available numbers. */
  localInventory?: Record<string, AvailableNumberStub[]>;
  /** Toll-free inventory. */
  tollFreeInventory?: AvailableNumberStub[];
  /** What `.create()` does on purchase. Default: success with a synthetic sid. */
  purchaseBehavior?: PurchaseBehavior;
  /** What `incomingPhoneNumbers.list()` returns (reconciliation path). */
  listAll?: ListedNumberStub[];
  /** What `incomingPhoneNumbers(sid).remove()` does. Default: success. */
  releaseBehavior?: ReleaseBehavior | ((sid: string) => ReleaseBehavior);
}

export interface TwilioMockCalls {
  /** Args of every `.local.list({ areaCode, ... })` call. */
  localList: Array<{ areaCode: number; smsEnabled?: boolean; voiceEnabled?: boolean; limit?: number }>;
  /** Count of `.tollFree.list(...)` calls. */
  tollFreeListCount: number;
  /** Args of every `.create({ ... })` purchase call. */
  create: Array<{
    phoneNumber: string;
    voiceUrl?: string;
    voiceMethod?: string;
    statusCallback?: string;
    statusCallbackMethod?: string;
  }>;
  /** Count of `.list(...)` calls on incomingPhoneNumbers (reconciliation). */
  listAllCount: number;
  /** SIDs passed to `incomingPhoneNumbers(sid).remove()`. */
  remove: string[];
}

export interface TwilioMockHandle {
  /** Pass this to `_setTwilioClientForTests`. Duck-typed to look like the SDK. */
  client: unknown;
  calls: TwilioMockCalls;
}

/**
 * Build a programmable Twilio client mock. All fields of opts are
 * optional — sensible defaults make the mock work out-of-the-box
 * for happy-path tests; pass overrides for failure-injection tests.
 */
export function createTwilioMock(opts: TwilioMockOptions = {}): TwilioMockHandle {
  const calls: TwilioMockCalls = {
    localList: [],
    tollFreeListCount: 0,
    create: [],
    listAllCount: 0,
    remove: [],
  };

  const purchaseBehavior: PurchaseBehavior = opts.purchaseBehavior ?? { kind: 'success' };
  const releaseBehavior = opts.releaseBehavior ?? { kind: 'success' };

  const incomingPhoneNumbersFn = (sid: string) => ({
    remove: async () => {
      calls.remove.push(sid);
      const behavior = typeof releaseBehavior === 'function' ? releaseBehavior(sid) : releaseBehavior;
      if (behavior.kind === 'throw') throw behavior.error;
      return;
    },
  });

  // Attach the create + list methods so the same name can be both
  // callable (for sid context access) and have properties (the SDK
  // pattern: `client.incomingPhoneNumbers.create(...)` AND
  // `client.incomingPhoneNumbers(sid).remove()`).
  const incomingPhoneNumbers: any = incomingPhoneNumbersFn;

  incomingPhoneNumbers.create = async (args: {
    phoneNumber: string;
    voiceUrl?: string;
    voiceMethod?: string;
    statusCallback?: string;
    statusCallbackMethod?: string;
  }) => {
    calls.create.push(args);
    if (purchaseBehavior.kind === 'throw') throw purchaseBehavior.error;
    if (purchaseBehavior.kind === 'malformed') return purchaseBehavior.response;
    // success
    return {
      sid: purchaseBehavior.sid ?? 'PN' + 'a'.repeat(32),
      phoneNumber: purchaseBehavior.phoneNumber ?? args.phoneNumber,
    };
  };

  incomingPhoneNumbers.list = async (args?: { limit?: number }) => {
    calls.listAllCount += 1;
    void args;
    return opts.listAll ?? [];
  };

  const localBuilder = {
    list: async (args: { areaCode: number; smsEnabled?: boolean; voiceEnabled?: boolean; limit?: number }) => {
      calls.localList.push(args);
      const key = String(args.areaCode);
      return opts.localInventory?.[key] ?? [];
    },
  };

  const tollFreeBuilder = {
    list: async (args?: { smsEnabled?: boolean; voiceEnabled?: boolean; limit?: number }) => {
      calls.tollFreeListCount += 1;
      void args;
      return opts.tollFreeInventory ?? [];
    },
  };

  const availablePhoneNumbers = (country: string) => {
    void country;
    return { local: localBuilder, tollFree: tollFreeBuilder };
  };

  const client = {
    availablePhoneNumbers,
    incomingPhoneNumbers,
  };

  return { client, calls };
}
