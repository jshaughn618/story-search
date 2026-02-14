declare module "rtf-parser" {
  type ParseCallback = (error: Error | null, document: unknown) => void;

  interface ParseFunction {
    (callback: ParseCallback): NodeJS.WritableStream;
    string: (input: string, callback: ParseCallback) => void;
  }

  const parse: ParseFunction;
  export default parse;
}
