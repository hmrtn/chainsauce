import { ethers } from "ethers";

export { default as JsonStorage } from "./storage/json.js";
export { default as PrismaStorage } from "./storage/prisma.js";
export { default as SqliteStorage } from "./storage/sqlite.js";

function debounce(func: Function, wait: number, immediate: boolean) {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  return function executedFunction() {
    var args = arguments;

    var later = function () {
      timeout = undefined;
      if (!immediate) func.apply(null, args);
    };

    var callNow = immediate && !timeout;

    clearTimeout(timeout);

    timeout = setTimeout(later, wait);

    if (callNow) {
      func.apply(null, args);
    }
  };
}

export type Event = {
  name: string;
  signature: string;
  args: { [key: string]: any };
  address: string;
  transactionHash: string;
  blockNumber: number;
  logIndex: number;
};

export type EventHandler<T extends Storage> = (
  indexer: Indexer<T>,
  event: Event
) => void | Promise<void>;

export type Subscription = {
  address: string;
  contract: ethers.Contract;
  fromBlock: number;
};

export interface Storage {
  getSubscriptions(): Promise<Subscription[]>;
  setSubscriptions(subscriptions: Subscription[]): Promise<void>;

  init?(): Promise<void>;
  write?(): Promise<void>;
  read?(): Promise<void>;
}

export type Options = {
  pollingInterval: number;
  enableLogs: boolean;
};

export const defaultOptions: Options = {
  pollingInterval: 20 * 1000,
  enableLogs: true,
};

export class Indexer<T extends Storage> {
  subscriptions: Subscription[];
  chainId: number;
  chainName: string;
  provider: Provider;
  eventHandler: EventHandler<T>;
  update: () => void;
  storage: T;

  lastBlock: number = 0;
  currentIndexedBlock: number = 0;
  isUpdating: boolean = false;
  options: Options;

  log(...data: any) {
    if (!this.options.enableLogs) {
      return;
    }
    console.log(`[${this.chainName}]`, ...data);
  }

  constructor(
    provider: Provider,
    network: ethers.providers.Network,
    subscriptions: Subscription[],
    persistence: T,
    handleEvent: EventHandler<T>,
    options: Partial<Options>
  ) {
    this.chainId = network.chainId;
    this.chainName = network.name;
    this.provider = provider;
    this.eventHandler = handleEvent;
    this.subscriptions = subscriptions;
    this.storage = persistence;
    this.options = Object.assign(defaultOptions, options);

    this.update = debounce(() => this._update(), 500, false);

    if (this.subscriptions.length > 0) {
      this.update();
    }

    setInterval(() => this._update(), this.options.pollingInterval);

    this.log(
      "Initialized indexer with",
      subscriptions.length,
      "contract subscriptions"
    );
  }

  async _update() {
    if (this.isUpdating) return;

    this.isUpdating = true;
    this.lastBlock = await this.provider.getBlockNumber();

    let pendingEvents: Event[] = [];

    while (true) {
      const subscriptionCount = this.subscriptions.length;
      const outdatedSubscriptions = this.subscriptions.filter((sub) => {
        return sub.fromBlock < this.lastBlock;
      });

      if (outdatedSubscriptions.length === 0 && pendingEvents.length === 0) {
        break;
      }

      this.log(
        "Fetching events for",
        outdatedSubscriptions.length,
        "subscriptions",
        "to block",
        this.lastBlock
      );

      const subscriptionBatches = outdatedSubscriptions.reduce(
        (acc: { [key: string]: Subscription[][] }, sub) => {
          acc[sub.fromBlock] ||= [[]];

          let last = acc[sub.fromBlock][acc[sub.fromBlock].length - 1];

          if (last.length > 10) {
            acc[sub.fromBlock].push([sub]);
          } else {
            last.push(sub);
          }
          return acc;
        },
        {}
      );

      let eventBatches = Promise.all(
        Object.entries(subscriptionBatches).flatMap(
          ([fromBlock, subscriptionBatches]) => {
            return subscriptionBatches.map(async (subscriptionBatch) => {
              let addresses = subscriptionBatch.map((s) => s.address);

              let eventContractIndex = Object.fromEntries(
                subscriptionBatch.flatMap(({ contract }) => {
                  return Object.keys(contract.interface.events).map((name) => {
                    return [
                      contract.interface.getEventTopic(name),
                      {
                        eventFragment: contract.interface.getEvent(name),
                        contract,
                      },
                    ];
                  });
                })
              );

              const from = Number(fromBlock);
              const to = this.lastBlock;

              const eventLogs = await getLogs(
                this.provider,
                from,
                to,
                addresses
              );

              if (eventLogs.length > 0) {
                this.log(
                  "Fetched events (",
                  eventLogs.length,
                  ")",
                  "Range:",
                  from,
                  "to",
                  to
                );
              }

              return eventLogs.flatMap((log: ethers.Event) => {
                try {
                  let fragmentContract = eventContractIndex[log.topics[0]];

                  if (!fragmentContract) return [];

                  let { eventFragment, contract } = fragmentContract;

                  let args = contract.interface.decodeEventLog(
                    eventFragment,
                    log.data,
                    log.topics
                  );

                  // console.log(log, args);

                  let event: Event = {
                    name: eventFragment.name,
                    args: args,
                    address: ethers.utils.getAddress(log.address),
                    signature: eventFragment.format(),
                    transactionHash: log.transactionHash,
                    blockNumber: log.blockNumber,
                    logIndex: log.logIndex,
                  };

                  return [event];
                } catch (e) {
                  // TODO: handle error
                  console.error(e);
                  return [];
                }
              });
            });
          }
        )
      );

      let events = (await eventBatches).flat();

      pendingEvents = pendingEvents.concat(events);

      pendingEvents.sort((a, b) => {
        return a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;
      });

      // let currentBlock = this.currentIndexedBlock;

      while (pendingEvents.length > 0) {
        const event = pendingEvents.shift()!;

        // currentBlock = Math.max(event, currentBlock);

        try {
          await this.eventHandler(this, event);
        } catch (e) {
          console.error("Failed to apply event", event);
          throw e;
        }

        // If a new subscription is added, stop playing events and catch up
        if (this.subscriptions.length > subscriptionCount) {
          break;
        }
      }

      for (let subscription of outdatedSubscriptions) {
        subscription.fromBlock = this.lastBlock;
      }

      this.storage.setSubscriptions(this.subscriptions);
    }

    this.log("Indexed up to", this.lastBlock);
    this.currentIndexedBlock = this.lastBlock;

    this.storage.setSubscriptions(this.subscriptions);

    if (this.storage.write) {
      this.storage.write();
    }

    this.isUpdating = false;
  }

  subscribe(address: string, abi: ethers.ContractInterface, fromBlock = 0) {
    if (this.subscriptions.find((s) => s.address === address)) {
      return false;
    }

    const contract = new ethers.Contract(address, abi);

    fromBlock = Math.max(this.currentIndexedBlock, fromBlock);

    this.log("Subscribed", contract.address, "from block", fromBlock);

    this.subscriptions.push({
      address: address,
      contract,
      fromBlock: fromBlock,
    });

    this.update();

    return contract;
  }
}

type Provider = ethers.providers.JsonRpcProvider;

async function getLogs(
  provider: Provider,
  fromBlock: number,
  toBlock: number,
  address: string[]
): Promise<ethers.Event[]> {
  try {
    let events: ethers.Event[] = await provider.send("eth_getLogs", [
      {
        fromBlock: ethers.utils.hexlify(fromBlock),
        toBlock: ethers.utils.hexlify(toBlock),
        address: address,
      },
    ]);

    return events;
  } catch (e) {
    console.error(
      `[${provider.network.name}]`,
      "Failed range:",
      fromBlock,
      "to",
      toBlock,
      "retrying smaller range ..."
    );

    const middle = (fromBlock + toBlock) >> 1;

    return (
      await Promise.all([
        getLogs(provider, fromBlock, middle, address),
        getLogs(provider, middle + 1, toBlock, address),
      ])
    ).flat();
  }
}

export async function createIndexer<T extends Storage>(
  provider: Provider,
  database: T,
  handleEvent: EventHandler<T>,
  options?: Partial<Options>
): Promise<Indexer<T>> {
  if (database.read) {
    await database.read();
  }

  if (database.init) {
    await database.init();
  }

  const subscriptions = await database.getSubscriptions();
  const network = await provider.getNetwork();
  return new Indexer(
    provider,
    network,
    subscriptions,
    database,
    handleEvent,
    options ?? {}
  );
}
