class Cap extends AudioWorkletProcessor { process(inputs: Float32Array[][], outputs: Float32Array[][]) { outputs[0]?.[0]?.fill(0); return true; } }
registerProcessor('capture', Cap as any);
export {};
