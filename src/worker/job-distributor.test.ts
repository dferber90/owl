import { expect } from "chai";
import EventEmitter from "events";
import { JobDistributor } from "./job-distributor";

export function makeBlocker() {
  const emitter = new EventEmitter();

  async function signal(forName: string = "") {
    emitter.emit(forName);
    await new Promise(setImmediate);
  }

  signal.block = (name: string = "") => {
    return new Promise<void>((resolve) => {
      emitter.on(name, () => {
        resolve();
      });
    });
  };

  return signal;
}

function tick() {
  return new Promise(setImmediate);
}

describe(JobDistributor.name, () => {
  it("fetches all available jobs", async () => {
    const availableJobs = ["a", "b", "c"];
    const workedJobs: string[] = [];

    const distributor = new JobDistributor<string>(
      async function* () {
        yield [""];
      },
      async () => {
        if (availableJobs.length === 0) {
          return ["empty"];
        }

        return ["success", availableJobs.pop()!];
      },
      async (job) => {
        workedJobs.push(job);
      }
    );

    await distributor.start();

    expect(workedJobs).to.eql(["c", "b", "a"]);
  });

  it("respects maxJob", async () => {
    const log: string[] = [];

    let fetchCount = 0;
    const blocker = makeBlocker();
    const distributor = new JobDistributor(
      async function* () {
        yield [""];
      },
      async () => {
        fetchCount++;

        if (fetchCount > 4) {
          return ["empty"];
        }

        log.push("fetch:" + fetchCount);
        blocker("fetch:" + fetchCount);

        return ["success", "" + fetchCount];
      },
      async (job) => {
        await tick();
        log.push("work:" + job);
        blocker("work:" + job);
      },
      3
    );

    distributor.start();

    await tick();

    expect(log).to.eql(["fetch:1", "fetch:2", "fetch:3"]);

    await blocker.block("work:1");
    await tick();

    expect(log).to.eql([
      "fetch:1",
      "fetch:2",
      "fetch:3",
      "work:1",
      "fetch:4",
      "work:2",
      "work:3",
    ]);
  });

  it("supports 'wait'", async () => {
    const log: string[] = [];

    let fetchCount = 0;
    const blocker = makeBlocker();
    const distributor = new JobDistributor(
      async function* () {
        yield [""];
      },
      async () => {
        fetchCount++;

        switch (fetchCount) {
          case 1:
            return ["wait", blocker.block("wait")];
          case 2:
            return ["success", "1"];
          default:
            return ["empty"];
        }
      },
      async (job) => {
        log.push("work:" + job);
      }
    );

    distributor.start();
    await tick();

    expect(log).to.eql([]);

    await blocker("wait");

    expect(log).to.eql(["work:1"]);
  });

  it("automatically fetches periodically", async () => {
    const log: string[] = [];

    let fetchCount = 0;
    const blocker = makeBlocker();
    const distributor = new JobDistributor(
      async function* () {
        yield [""];
      },
      async () => {
        fetchCount++;
        log.push("fetch:" + fetchCount);
        return ["empty"];
      },
      async (job) => {}
    );

    distributor.setTimeout = (cb) => {
      blocker.block("timeout").then(cb);
      return null as any;
    };

    await distributor.start();

    expect(log).to.eql(["fetch:1"]);

    await blocker("timeout");

    expect(log).to.eql(["fetch:1", "fetch:2"]);
  });

  it("retries when blocked", async () => {
    const log: string[] = [];
    const queue = ["a", "block"];

    const distributor = new JobDistributor(
      async function* () {
        yield [""];
      },
      async () => {
        log.push("fetch");
        const item = queue.pop();

        if (!item) {
          return ["empty"];
        }

        if (item === "block") {
          return ["retry"];
        }

        return ["success", item];
      },
      async (job) => {
        log.push("work:" + job);
      }
    );

    distributor.setTimeout = (cb) => {
      return null as any;
    };

    await distributor.start();

    expect(log).to.eql(["fetch", "fetch", "work:a", "fetch", "fetch"]);
  });

  describe("error handling", () => {
    describe("during fetching", () => {
      it("throws", async () => {
        const distributor = new JobDistributor(
          async function* () {
            yield [""];
          },
          async () => {
            throw new Error("Fetch failed!");
          },
          async (job) => {}
        );

        distributor.setTimeout = (cb) => {
          return null as any;
        };

        try {
          await distributor.start();

          expect(false).to.be.true;
        } catch (error) {
          expect(error.message).to.equal("Fetch failed!");
        }
      });
    });
    describe("during execution", () => {
      let oldError: any;
      const errors: any[][] = [];
      before(() => {
        oldError = global.console.error;
        global.console.error = (...args: any[]) => {
          errors.push(args.map(String));
        };
      });

      after(() => {
        global.console.error = oldError;
      });

      it("console.errors", async () => {
        let call = 0;
        const distributor = new JobDistributor(
          async function* () {
            yield [""];
          },
          async () => {
            call++;
            if (call === 1) {
              return ["success", "job"];
            }
            return ["empty"];
          },
          async (job) => {
            throw new Error("Run failed!");
          }
        );

        distributor.setTimeout = (cb) => {
          return null as any;
        };

        await distributor.start();

        expect(errors).to.eql([["Error: Run failed!"]]);
      });
    });
  });

  it("Cluster-Mode", async () => {
    const tenants: Record<string, string[]> = {
      a: ["a2", "block", "a1"],
      b: ["b1"],
    };

    const log: string[] = [];

    const distributor = new JobDistributor(
      async function* () {
        log.push("fetch-initial-tenants");
        yield Object.keys(tenants);
      },
      async (tenant: string) => {
        const queue = tenants[tenant];
        const item = queue.pop();
        if (!item) {
          log.push("fetch:" + tenant + ":empty");
          return ["empty"];
        }

        if (item === "block") {
          log.push("fetch:" + tenant + ":retry");
          return ["retry"];
        }

        log.push("fetch:" + tenant + ":success");

        return ["success", item];
      },
      async (job, tenant) => {
        log.push("work:" + tenant + ":" + job);
      }
    );

    await distributor.start();

    expect(log).to.eql([
      "fetch-initial-tenants",
      "fetch:a:success",
      "fetch:b:success",
      "work:a:a1",
      "fetch:a:retry",
      "work:b:b1",
      "fetch:b:empty",
      "fetch:a:success",
      "fetch:a:empty",
      "fetch:b:empty",
      "work:a:a2",
      "fetch:a:empty",
      "fetch:a:empty",
    ]);
  });
});
