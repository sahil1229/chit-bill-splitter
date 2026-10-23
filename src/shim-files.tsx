import React, { useCallback, useState } from 'react';
export function FileCard({ children }: { children?: React.ReactNode }) { return <>{children}</>; }
export function FileRouter({ children }: { children?: React.ReactNode }) { return <>{children}</>; }
export function useLocalState<T>(key:string,init:T):[T,(v:T)=>void,{ready:boolean;message?:string;loadError?:string}]{
 const [boot]=useState(()=>{try{const raw=localStorage.getItem('chit.'+key);if(raw===null)return{value:init,error:''};const parsed=JSON.parse(raw);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('Invalid saved bill');return{value:{...init as object,...parsed}as T,error:''};}catch{return{value:init,error:'The saved bill could not be read. No new bill was opened. Enable browser storage or restore the saved data, then reload. Do not pay from this page.'};}});
 const [v,setV]=useState<T>(boot.value);const [message,setMessage]=useState('');
 const set=useCallback((n:T)=>{if(boot.error)return;setV(n);try{const text=JSON.stringify(n);localStorage.setItem('chit.'+key,text);if(localStorage.getItem('chit.'+key)!==text)throw Error('Save failed');setMessage('');}catch{setMessage((n as any)?.settlement ? 'The latest change was NOT saved. The prior finalized bill is still saved. Restore browser storage, then reload to recover the saved receipt status. Payment links and exports are blocked on this page.' : 'Changes are not saved on this device. Do not reload or close this page. You can prepare a bill, but finalization and payment are blocked until storage works.');}},[key,boot.error]);
 return[v,set,{ready:true,message:message||undefined,loadError:boot.error||undefined}];
}
