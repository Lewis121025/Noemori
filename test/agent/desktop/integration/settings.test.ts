import { beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSettingsStore } from "../../../../modules/notes/packages/desktop/src/features/agent/main/settings";
import type { ModelSettingsUpdate } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/api";
const encryption=vi.hoisted(()=>({available:true}));
vi.mock("electron",()=>({safeStorage:{isEncryptionAvailable:()=>encryption.available,encryptString:(value:string)=>Buffer.from(value).map((byte)=>byte^0x5a),decryptString:(value:Buffer)=>Buffer.from(value).map((byte)=>byte^0x5a).toString()}}));
beforeEach(()=>{encryption.available=true;});
function settings():ModelSettingsUpdate{return {protocol:"openai-chat",model:"fixture",endpoint:"https://example.com/chat",authentication:{type:"bearer",value:"private-api-secret"},tools:true,streaming:true,vision:false,audio:false,video:false};}

it("认证只在主进程解密，设置投影和磁盘文件不出现原文",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"agent-settings-"));try{
    const store=new AgentSettingsStore(directory);expect(await store.public()).toBeNull();const visible=await store.save(settings());
    expect(JSON.stringify(visible)).not.toContain("private-api-secret");expect(visible.authentication.configured).toBe(true);
    expect(await readFile(join(directory,"agent-model.json"),"utf8")).not.toContain("private-api-secret");
    expect((await store.load())?.authentication).toEqual({type:"bearer",value:"private-api-secret"});
    await store.save({...settings(),model:"changed",authentication:null});expect((await store.load())?.authentication).toEqual({type:"bearer",value:"private-api-secret"});
  }finally{await rm(directory,{recursive:true,force:true});}
});

it("系统加密不可用时不落盘凭据，已有配置仍保持原值",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"agent-settings-"));try{
    const store=new AgentSettingsStore(directory);await store.save({...settings(),authentication:{type:"none"}});const before=await readFile(join(directory,"agent-model.json"),"utf8");
    encryption.available=false;await expect(store.save(settings())).rejects.toThrow("安全存储");expect(await readFile(join(directory,"agent-model.json"),"utf8")).toBe(before);
  }finally{await rm(directory,{recursive:true,force:true});}
});
