import { expect } from "chai";
import { Worker } from "../../src/worker/worker";
import { delay, describeAcrossBackends, waitUntil } from "../util";
import { makeProducerEnv } from "./support";

describeAcrossBackends("stale-check", (backend) => {
  const env = makeProducerEnv(backend, {
    staleChecker: {
      interval: "manual",
      staleAfter: 1000,
    },
  });
  beforeEach(env.setup);
  afterEach(async () => {
    await worker.close();
    await env.teardown();
  });

  let worker: Worker;

  it("emits errors for stalling jobs", async () => {
    worker = env.owl.createWorker(async () => {
      // happily takes jobs, but never acknowledges any of them
      // simulating a dying worker
    });

    await env.producer.enqueue({
      tenant: "",
      id: "stalling-job",
      payload: "i am stalling, just like susanne",
      queue: "stally-stall",
    });

    await env.producer.staleChecker.check();
    expect(env.errors).to.deep.equal([]);

    await delay(1500);

    await env.producer.staleChecker.check();
    expect(env.errors).to.deep.equal([
      [
        {
          tenant: "",
          jobId: "stalling-job",
          queueId: "stally-stall",
          timestampForNextRetry: undefined,
        },
        "Job Timed Out",
      ],
    ]);
  });

  it("reschedules jobs with retry", async () => {
    let calls = 0;
    worker = env.owl.createWorker(async (job, ack) => {
      calls++;
      if (job.count > 1) {
        await worker.acknowledger.acknowledge(ack);
      }
    });

    await env.producer.enqueue({
      tenant: "",
      id: "retryable-stalling-job",
      payload: "i am stalling, just like susanne",
      queue: "retry-stally-stall",
      retry: [100],
    });

    await env.producer.staleChecker.check();
    expect(env.errors).to.deep.equal([]);

    await delay(1100);

    await env.producer.staleChecker.check();
    expect(env.errors).to.deep.equal([]);

    await waitUntil(() => calls === 2, 800);
  });

  it("does not emit errors if everything is fine", async () => {
    worker = env.owl.createWorker(async (job, ack) => {
      setTimeout(() => {
        worker.acknowledger.acknowledge(ack);
      }, 500);
    });

    await env.producer.enqueue({
      tenant: "",
      id: "non-stalling-job",
      payload: "i am not stalling",
      queue: "unstally-stall",
    });

    await env.producer.staleChecker.check();
    expect(env.errors).to.deep.equal([]);

    await delay(1500);

    await env.producer.staleChecker.check();
    expect(env.errors).to.deep.equal([]);
  });
});
