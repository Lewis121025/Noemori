import { selectorEngineSource, selectorEngineVersion } from "../browser/selector-engine.js";

/** 固定引擎在每个隔离世界独立缓存；模型只能提供已经校验的结构化查询。 */
export function semanticEngineExpression(key: string): string {
  if (selectorEngineVersion !== "1.63.0") throw new Error("选择引擎版本未经验证");
  const options = {
    isUnderTest: false,
    sdkLanguage: "javascript",
    frameSeq: 1,
    testIdAttributeName: "data-testid",
    stableRafCount: 1,
    browserName: "chromium",
    shouldPrependErrorPrefix: false,
    isUtilityWorld: true,
    customEngines: [],
  };
  return `(()=>{const key=${JSON.stringify(key)};let engine=Reflect.get(window,key);if(!engine){const module={};${selectorEngineSource}\nengine=new(module.exports.InjectedScript())(globalThis,${JSON.stringify(options)});Reflect.set(window,key,engine);}return engine;})()`;
}
