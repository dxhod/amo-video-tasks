import {afterEach,describe,it,expect,vi} from 'vitest';
import {deliverNotification} from './notifications';
import type {ServiceClient} from './service';
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
describe('Telegram delivery',()=>{
 it.each([true,false])('records the result independently of video jobs, success=%s',async success=>{
  vi.stubEnv('TELEGRAM_BOT_TOKEN','test-token');vi.stubEnv('TELEGRAM_CHAT_ID','test-chat');
  const request=vi.fn().mockResolvedValue({ok:success,status:success?200:503,json:async()=>({ok:success})});vi.stubGlobal('fetch',request);
  const rpc=vi.fn().mockResolvedValueOnce({data:{id:'notification',token:'lease',error_id:'error',stage:'render',type:'INVALID_MEDIA',task_id:'task'},error:null}).mockResolvedValueOnce({data:null,error:null});
  await deliverNotification({rpc} as unknown as ServiceClient);
  expect(rpc.mock.calls[1][0]).toBe('notification_finish');expect(rpc.mock.calls[1][1].p_error).toBe(success?null:'Telegram HTTP 503');
  const payload=JSON.parse(request.mock.calls[0][1].body);expect(payload.text).toContain('error');expect(payload.text).not.toContain('test-token');
 });
 it('retains notification when credentials are absent',async()=>{
  vi.stubEnv('TELEGRAM_BOT_TOKEN','');vi.stubEnv('TELEGRAM_CHAT_ID','');const request=vi.fn();vi.stubGlobal('fetch',request);
  const rpc=vi.fn().mockResolvedValueOnce({data:{id:'n',token:'lease'},error:null}).mockResolvedValueOnce({data:null,error:null});await deliverNotification({rpc} as unknown as ServiceClient);expect(request).not.toHaveBeenCalled();expect(rpc.mock.calls[1][1].p_error).toContain('не налаштований');
 });
});
