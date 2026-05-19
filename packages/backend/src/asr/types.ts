export interface TranscribeOptions {
  language?: string;
  prompt?: string;
}

export interface AsrClient {
  readonly name: string;
  transcribe(wavBuffer: Buffer, opts?: TranscribeOptions): Promise<string>;
}
