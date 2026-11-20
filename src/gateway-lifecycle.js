// Own one child until its close event; a sent signal is not a completed shutdown.
export function createGatewayLifecycle({ stopTimeoutMs = 60_000 } = {}) {
  let child = null;
  let stopTask = null;
  let maintenance = false;
  let shuttingDown = false;

  function assertCanStart() {
    if (maintenance || shuttingDown) {
      throw new Error("Gateway is stopping or undergoing maintenance");
    }
  }

  function track(proc) {
    assertCanStart();
    if (child) throw new Error("A gateway child is already managed");
    child = proc;
    proc.once("close", () => {
      if (child === proc) child = null;
    });
  }

  function stop() {
    if (stopTask) return stopTask;
    const proc = child;
    if (!proc) return Promise.resolve();

    const task = new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        proc.off("close", onClose);
      };
      const onClose = () => {
        cleanup();
        resolve();
      };
      // Listen before signalling, including for a child that is already exiting.
      proc.once("close", onClose);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Gateway did not close within ${stopTimeoutMs} ms; still tracking the existing process`));
      }, stopTimeoutMs);
      try {
        proc.kill("SIGTERM");
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
    const pending = task.finally(() => {
      if (stopTask === pending) stopTask = null;
    });
    stopTask = pending;
    return pending;
  }

  async function withStopped(action) {
    assertCanStart();
    maintenance = true;
    try {
      await stop();
      return await action();
    } finally {
      maintenance = false;
    }
  }

  return {
    get child() { return child; },
    get unavailable() { return maintenance || shuttingDown; },
    assertCanStart,
    track,
    stop,
    withStopped,
    shutdown() {
      shuttingDown = true;
      return stop();
    },
  };
}
