import { Config, intoConfig, ShapeConfig } from "./config";
import { Member } from "./page";
import rdfDereference, { RdfDereferencer } from "rdf-dereference";
import { FileStateFactory, NoStateFactory, State, StateFactory } from "./state";
import { CBDShapeExtractor } from "extract-cbd-shape";
import { RdfStore } from "rdf-stores";
import { DataFactory } from "rdf-data-factory";
import { Writer as NWriter } from "n3";
import { Quad_Object, Term } from "@rdfjs/types";
import { getObjects, ModulatorFactory, Notifier, streamToArray } from "./utils";
import { LDES, SDS, TREE } from "@treecg/types";
import { FetchedPage, Fetcher, longPromise, resetPromise } from "./pageFetcher";
import { Manager } from "./memberManager";
import { OrderedStrategy, StrategyEvents, UnorderedStrategy } from "./strategy";
import debug from "debug";
import type { Writer } from "@ajuvercr/js-runner";

export { intoConfig } from "./config";
export type { Member, Page, Relation } from "./page";
export type { Config, MediatorConfig, ShapeConfig } from "./config";

const df = new DataFactory();
const log = debug("client");
const { namedNode, blankNode, quad } = df;

type Controller = ReadableStreamDefaultController<Member>;

export type Ordered = "ascending" | "descending" | "none";

export function replicateLDES(
  config: Config,
  states: {
    membersState?: State;
    fragmentState?: State;
    dereferencer?: RdfDereferencer;
  } = {},
  streamId?: Term,
  ordered: Ordered = "none",
): Client {
  return new Client(config, states, streamId, ordered);
}

export type LDESInfo = {
  shape?: Term;
  extractor: CBDShapeExtractor;
  timestampPath?: Term;
  isVersionOfPath?: Term;
};

async function getInfo(
  ldesId: Term,
  store: RdfStore,
  dereferencer: RdfDereferencer,
  config: Config,
): Promise<LDESInfo> {
  const logger = log.extend("getShape");

  if (config.shapeFile) {
    const shapeId = config.shapeFile.startsWith("http")
      ? config.shapeFile
      : "file://" + config.shapeFile;

    const resp = await rdfDereference.dereference(config.shapeFile, {
      localFiles: true,
    });
    const quads = await streamToArray(resp.data);
    config.shape = {
      quads: quads,
      shapeId: namedNode(shapeId),
    };
  }

  let shapeIds = config.noShape
    ? []
    : getObjects(store, ldesId, TREE.terms.shape);
  let timestampPaths = getObjects(store, ldesId, LDES.terms.timestampPath);
  let isVersionOfPaths = getObjects(store, ldesId, LDES.terms.versionOfPath);

  logger(
    "Found %d shapes, %d timestampPaths, %d isVersionOfPaths",
    shapeIds.length,
    timestampPaths.length,
    isVersionOfPaths.length,
  );

  if (
    !config.noShape &&
    (shapeIds.length === 0 ||
      timestampPaths.length === 0 ||
      isVersionOfPaths.length === 0)
  ) {
    try {
      logger("Maybe find more info at %s", ldesId.value);
      const resp = await dereferencer.dereference(ldesId.value, {
        localFiles: true,
      });
      store = RdfStore.createDefault();
      await new Promise((resolve, reject) => {
        store.import(resp.data).on("end", resolve).on("error", reject);
      });
      shapeIds = getObjects(store, null, TREE.terms.shape);
      timestampPaths = getObjects(store, null, LDES.terms.timestampPath);
      isVersionOfPaths = getObjects(store, null, LDES.terms.versionOfPath);
      logger(
        "Found %d shapes, %d timestampPaths, %d isVersionOfPaths",
        shapeIds.length,
        timestampPaths.length,
        isVersionOfPaths.length,
      );
    } catch (ex: any) {}
  }

  if (shapeIds.length > 1) {
    console.error("Expected at most one shape id, found " + shapeIds.length);
  }

  if (timestampPaths.length > 1) {
    console.error(
      "Expected at most one timestamp path, found " + timestampPaths.length,
    );
  }

  if (isVersionOfPaths.length > 1) {
    console.error(
      "Expected at most one versionOf path, found " + isVersionOfPaths.length,
    );
  }

  let shapeConfigStore = RdfStore.createDefault();
  if (config.shape) {
    for (let quad of config.shape.quads) {
      shapeConfigStore.addQuad(quad);
    }
  }

  return {
    extractor: new CBDShapeExtractor(
      config.shape ? shapeConfigStore : store,
      dereferencer,
      {
        cbdDefaultGraph: config.onlyDefaultGraph,
      },
    ),
    shape: config.shape ? config.shape.shapeId : shapeIds[0],
    timestampPath: timestampPaths[0],
    isVersionOfPath: isVersionOfPaths[0],
  };
}

type EventMap = Record<string, any>;

type EventKey<T extends EventMap> = string & keyof T;
type EventReceiver<T> = (params: T) => void;

export type ClientEvents = {
  fragment: void;
  poll: void;
};

export class Client {
  private config: Config;
  private dereferencer: RdfDereferencer;

  private fetcher!: Fetcher;
  private memberManager!: Manager;
  private strategy!: OrderedStrategy | UnorderedStrategy;

  public streamId?: Term;
  private ordered: Ordered;

  private modulatorFactory;

  private pollCycle: (() => void)[] = [];
  private stateFactory: StateFactory;

  private listeners: {
    [K in keyof ClientEvents]?: Array<(p: ClientEvents[K]) => void>;
  } = {};

  constructor(
    config: Config,
    {
      dereferencer,
    }: {
      membersState?: State;
      fragmentState?: State;
      dereferencer?: RdfDereferencer;
    } = {},
    stream?: Term,
    ordered: Ordered = "none",
  ) {
    this.config = config;
    this.dereferencer = dereferencer ?? rdfDereference;

    this.streamId = stream;
    this.ordered = ordered;
    this.stateFactory = config.stateFile
      ? new FileStateFactory(config.stateFile)
      : new NoStateFactory();
    this.modulatorFactory = new ModulatorFactory(this.stateFactory);

    if (process) {
      process.on("SIGINT", () => {
        console.log("Caught interrupt signal, saving");
        this.stateFactory.write();
        process.exit();
      });
    }
  }

  on<K extends EventKey<ClientEvents>>(
    key: K,
    fn: EventReceiver<ClientEvents[K]>,
  ) {
    this.listeners[key] = (
      this.listeners[key] || <Array<(p: ClientEvents[K]) => void>>[]
    ).concat(fn);
  }

  private emit<K extends EventKey<ClientEvents>>(
    key: K,
    data: ClientEvents[K],
  ) {
    (this.listeners[key] || []).forEach(function (fn) {
      fn(data);
    });
  }

  addPollCycle(cb: () => void) {
    this.pollCycle.push(cb);
  }

  async init(
    emit: (member: Member) => void,
    close: () => void,
    factory: ModulatorFactory,
  ): Promise<void> {
    const logger = log.extend("init");
    // Fetch the url
    const root = await fetchPage(this.config.url, this.dereferencer);
    // Try to get a shape
    // TODO Choose a view
    const viewQuads = root.data.getQuads(null, TREE.terms.view, null, null);

    let ldesId: Term = namedNode(this.config.url);
    if (!this.config.urlIsView) {
      if (viewQuads.length === 0) {
        console.error(
          "Did not find tree:view predicate, this is required to interpret the LDES",
        );
      } else {
        ldesId = viewQuads[0].object;
      }
    }

    const info = await getInfo(
      ldesId,
      root.data,
      this.dereferencer,
      this.config,
    );

    const state = this.stateFactory.build<Set<string>>(
      "members",
      (set) => {
        const arr = [...set.values()];
        return JSON.stringify(arr);
      },
      (inp) => new Set(JSON.parse(inp)),
      () => new Set(),
    );
    this.streamId = this.streamId || viewQuads[0].subject;
    this.memberManager = new Manager(
      this.streamId || viewQuads[0].subject,
      state.item,
      info,
    );

    logger("timestampPath %o", !!info.timestampPath);

    if (this.ordered !== "none" && !info.timestampPath) {
      throw "Can only emit members in order, if LDES is configured with timestampPath";
    }

    this.fetcher = new Fetcher(this.dereferencer, this.config.loose);

    const notifier: Notifier<StrategyEvents, {}> = {
      fragment: () => this.emit("fragment", undefined),
      member: (m) => {
        emit(m);
      },
      pollCycle: () => {
        this.emit("poll", undefined);
        this.pollCycle.forEach((cb) => cb());
      },
      close: () => {
        this.stateFactory.write();
        close();
      },
    };

    this.strategy =
      this.ordered !== "none"
        ? new OrderedStrategy(
            this.memberManager,
            this.fetcher,
            notifier,
            factory,
            this.ordered,
            this.config.polling,
            this.config.pollInterval,
          )
        : new UnorderedStrategy(
            this.memberManager,
            this.fetcher,
            notifier,
            factory,
            this.config.polling,
            this.config.pollInterval,
          );

    logger("Found %d views, choosing %s", viewQuads.length, ldesId.value);
    this.strategy.start(ldesId.value);
  }

  stream(strategy?: {
    highWaterMark?: number;
    size?: (chunk: Member) => number;
  }): ReadableStream<Member> {
    const emitted = longPromise();
    const config: UnderlyingDefaultSource = {
      start: async (controller: Controller) => {
        this.modulatorFactory.pause();
        await this.init(
          (member) => {
            controller.enqueue(member);
            resetPromise(emitted);
          },
          () => controller.close(),
          this.modulatorFactory,
        );
      },
      pull: async () => {
        resetPromise(emitted);
        this.modulatorFactory.unpause();
        await emitted.waiting;
        this.modulatorFactory.pause();
        return;
      },
      cancel: async () => {
        this.stateFactory.write();
        console.log("Cancled");
        this.strategy.cancle();
      },
    };

    const out = new ReadableStream(config, strategy);
    return out;
  }
}

async function fetchPage(
  location: string,
  dereferencer: RdfDereferencer,
): Promise<FetchedPage> {
  const resp = await dereferencer.dereference(location, { localFiles: true });
  const url = resp.url;
  const data = RdfStore.createDefault();
  await new Promise((resolve, reject) => {
    data.import(resp.data).on("end", resolve).on("error", reject);
  });
  return <FetchedPage>{ url, data };
}

export async function processor(
  writer: Writer<string>,
  url: string,
  ordered?: string,
  follow?: boolean,
  pollInterval?: number,
  shape?: string,
  noShape?: boolean,
  save?: string,
  loose?: boolean,
  urlIsView?: boolean,
  verbose?: boolean,
) {
  const client = replicateLDES(
    intoConfig({
      loose,
      noShape,
      shapeFile: shape,
      polling: follow,
      url: url,
      stateFile: save,
      follow,
      pollInterval: pollInterval,
      fetcher: { maxFetched: 2, concurrentRequests: 10 },
      urlIsView,
    }),
    undefined,
    undefined,
    <Ordered>ordered || "none",
  );

  if (verbose) {
    client.on("fragment", () => console.error("Fragment!"));
  }

  return async () => {
    const reader = client.stream({ highWaterMark: 10 }).getReader();
    let el = await reader.read();
    const seen = new Set();
    while (el) {
      if (el.value) {
        seen.add(el.value.id);

        if (verbose) {
          if (seen.size % 100 == 1) {
            console.error(
              "Got member",
              seen.size,
              "with",
              el.value.quads.length,
              "quads",
            );
          }
        }

        const blank = blankNode();
        const quads = el.value.quads.slice();
        quads.push(
          quad(blank, SDS.terms.stream, <Quad_Object>client.streamId!),
          quad(blank, SDS.terms.payload, <Quad_Object>el.value.id!),
        );

        await writer.push(new NWriter().quadsToString(quads));
      }

      if (el.done) {
        break;
      }

      el = await reader.read();
    }

    if (verbose) {
      console.error("Found", seen.size, "members");
    }
  };
}
