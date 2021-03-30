import { expect } from "chai";
import { describeAcrossBackends, makeSignal } from "../util";
import { makeProducerEnv } from "./support";

describeAcrossBackends("dontReschedule", (backend) => {
  it("works", async () => {
    const producerEnv = makeProducerEnv(backend);
    await producerEnv.setup();

    const acknowledged = makeSignal();
    const worker = producerEnv.owl.createWorker(async (job, meta) => {
      await worker.acknowledger.acknowledge(meta, {
        dontReschedule: true,
      });
      acknowledged.signal();
    });

    await producerEnv.producer.enqueue({
      id: "a",
      queue: "q",
      payload: "p",
      schedule: {
        type: "every",
        meta: "1000",
      },
    });

    await acknowledged;

    const job = await producerEnv.producer.findById("q", "a");
    expect(job).to.be.null;

    await producerEnv.teardown();
    await worker.close();
  });
});
