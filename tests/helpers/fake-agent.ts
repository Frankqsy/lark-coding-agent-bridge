import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../../src/agent/types.js';

export interface FakeAgentRun extends AgentRun {
  readonly opts: AgentRunOptions;
  readonly stopped: boolean;
  readonly waitForExitCalls: number;
  /** Text handed to {@link AgentRun.steer}, in call order. */
  readonly steeredTexts: readonly string[];
}

class FakeRun implements FakeAgentRun {
  readonly runId: string;
  readonly opts: AgentRunOptions;
  readonly events: AsyncIterable<AgentEvent>;
  readonly waitForExitResult: boolean;
  readonly steeredTexts: string[] = [];
  readonly steer: ((text: string) => Promise<boolean>) | undefined;
  #stopped = false;
  #waitForExitCalls = 0;
  /** Events queued while the run is mid-flight (see {@link #onSteer}). */
  #injected: AgentEvent[] = [];
  #wake: (() => void) | undefined;
  readonly #holdOpen: boolean;
  readonly #onSteer: readonly AgentEvent[];

  constructor(
    opts: AgentRunOptions,
    events: readonly AgentEvent[],
    waitForExitResult: boolean,
    behaviour: { steerable: boolean; holdOpen: boolean; onSteer: readonly AgentEvent[] },
  ) {
    this.runId = opts.runId;
    this.opts = opts;
    this.waitForExitResult = waitForExitResult;
    this.#holdOpen = behaviour.holdOpen;
    this.#onSteer = behaviour.onSteer;
    this.events = this.iterate(events);
    if (behaviour.steerable) {
      this.steer = async (text: string) => {
        if (this.#stopped) return false;
        this.steeredTexts.push(text);
        this.#inject(this.#onSteer);
        return true;
      };
    }
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  get waitForExitCalls(): number {
    return this.#waitForExitCalls;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#wake?.();
  }

  async waitForExit(): Promise<boolean> {
    this.#waitForExitCalls++;
    return this.waitForExitResult;
  }

  private async *iterate(events: readonly AgentEvent[]): AsyncIterable<AgentEvent> {
    const queue = [...events];
    for (;;) {
      if (this.#stopped) return;
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      // A run that stays open until it is stopped, so a test can drive a
      // message into it mid-flight and then watch the bridge react when it
      // dies. Anything injected meanwhile (a steer's reply) lands first.
      if (!this.#holdOpen) return;
      queue.push(...this.#injected.splice(0));
      if (queue.length > 0) continue;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = undefined;
    }
  }

  #inject(events: readonly AgentEvent[]): void {
    if (events.length === 0) return;
    this.#injected.push(...events);
    this.#wake?.();
  }
}

export type FakeAgentEvents =
  | readonly AgentEvent[]
  | readonly (readonly AgentEvent[])[];

export class FakeAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly runs: FakeAgentRun[] = [];
  readonly runOptions: AgentRunOptions[] = [];
  botIdentity: AgentBotIdentity | undefined;
  #available: boolean;
  #steerable: boolean;
  #holdOpenRuns: number;
  #steerReplies: AgentEvent[];
  #eventRuns: AgentEvent[][];
  #waitForExitResults: boolean[];

  constructor(options: {
    id?: string;
    displayName?: string;
    available?: boolean;
    events?: FakeAgentEvents;
    waitForExit?: boolean | readonly boolean[];
    /** Runs accept mid-turn input, i.e. expose a `steer` that returns true. */
    steerable?: boolean;
    /** How many leading runs stay open until `stop()` is called on them. */
    holdOpenRuns?: number;
    /** Events a run emits in answer to {@link AgentRun.steer}. */
    steerReplies?: readonly AgentEvent[];
  } = {}) {
    this.id = options.id ?? 'fake-agent';
    this.displayName = options.displayName ?? 'Fake Agent';
    this.#available = options.available ?? true;
    this.#steerable = options.steerable ?? false;
    this.#holdOpenRuns = options.holdOpenRuns ?? 0;
    this.#steerReplies = [...(options.steerReplies ?? [])];
    this.#eventRuns = normalizeEventRuns(options.events ?? []);
    this.#waitForExitResults = normalizeWaitForExitResults(options.waitForExit);
  }

  async isAvailable(): Promise<boolean> {
    return this.#available;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  run(opts: AgentRunOptions): AgentRun {
    this.runOptions.push(opts);
    const events = this.#eventRuns.shift() ?? [];
    const waitForExitResult = this.#waitForExitResults.shift() ?? true;
    const run = new FakeRun(opts, events, waitForExitResult, {
      steerable: this.#steerable,
      holdOpen: this.#holdOpenRuns > 0,
      onSteer: this.#steerReplies,
    });
    this.#holdOpenRuns = Math.max(0, this.#holdOpenRuns - 1);
    this.runs.push(run);
    return run;
  }

  enqueue(...events: AgentEvent[]): void {
    if (this.#eventRuns.length === 0) this.#eventRuns.push([]);
    this.#eventRuns[0]?.push(...events);
  }

  setEvents(events: FakeAgentEvents): void {
    this.#eventRuns = normalizeEventRuns(events);
  }

  setAvailable(available: boolean): void {
    this.#available = available;
  }

  setWaitForExit(result: boolean | readonly boolean[]): void {
    this.#waitForExitResults = normalizeWaitForExitResults(result);
  }
}

export function createFakeAgent(events: readonly AgentEvent[] = []): FakeAgentAdapter {
  return new FakeAgentAdapter({ events });
}

function normalizeEventRuns(events: FakeAgentEvents): AgentEvent[][] {
  if (events.length === 0) return [];
  return Array.isArray(events[0])
    ? (events as readonly (readonly AgentEvent[])[]).map((runEvents) => [...runEvents])
    : [[...(events as readonly AgentEvent[])]];
}

function normalizeWaitForExitResults(result: boolean | readonly boolean[] | undefined): boolean[] {
  if (result === undefined) return [];
  if (typeof result === 'boolean') return [result];
  return [...result];
}
