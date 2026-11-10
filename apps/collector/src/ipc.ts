export interface ParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: any }) => void): void;
  removeListener(event: 'message', listener: (event: { data: any }) => void): void;
}

// Electron utilityProcess and Node child_process use different IPC APIs.
export function collectorIPC(runtime = process as NodeJS.Process & { parentPort?: ParentPort }) {
  return {
    send(message: unknown) {
      if (runtime.parentPort) runtime.parentPort.postMessage(message);
      else if (runtime.send && runtime.connected) runtime.send(message);
    },
    onMessage(listener: (message: any) => void): () => void {
      if (runtime.parentPort) {
        const receive = (event: { data: any }) => listener(event.data);
        runtime.parentPort.on('message', receive);
        return () => runtime.parentPort!.removeListener('message', receive);
      }
      runtime.on('message', listener);
      return () => { runtime.removeListener('message', listener); };
    },
  };
}
