(()=>{
  'use strict';
  const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
  function clickExisting(selector){const el=$(selector);if(el&&!el.disabled){el.click();return true;}return false;}
  function jumpToView(view){const target=$(`[data-view="${view}"]`)||$(`[data-ui-view="${view}"]`);target?.click();}

  function makeEmptyState(el,{icon='○',title,description,actions=[]}){
    if(!el||el.dataset.p3Empty==='1')return;el.dataset.p3Empty='1';
    el.classList.add('p3-empty-state');el.classList.remove('empty');
    el.innerHTML=`<div class="p3-empty-icon" aria-hidden="true">${icon}</div><h3>${title}</h3><p>${description}</p>${actions.length?`<div class="p3-empty-actions">${actions.map((a,i)=>`<button class="btn ${a.kind||'outline'}" type="button" data-p3-action="${i}">${a.label}</button>`).join('')}</div>`:''}`;
    actions.forEach((a,i)=>el.querySelector(`[data-p3-action="${i}"]`)?.addEventListener('click',a.run));
  }

  function enhanceEmptyStates(root=document){
    // Dispatch: distinguish "no records" from "filters returned zero".
    const summary=$('#dispatchFilterSummary',root)||$('#dispatchFilterSummary');
    if(summary){
      const m=summary.textContent.match(/顯示\s*(\d+)\s*\/\s*(\d+)/);const shown=Number(m?.[1]),total=Number(m?.[2]);
      const empty=$('#dispatchTripRows .empty',root)||$('#dispatchTripRows .empty');
      if(empty&&shown===0){
        if(total>0)makeEmptyState(empty,{icon:'⌕',title:'沒有符合目前篩選的行程',description:'今天有行程，但目前的狀態、司機、車輛或關鍵字篩選沒有符合結果。',actions:[{label:'清除所有篩選',kind:'primary',run:()=>clickExisting('#clearTripFiltersBtn')}]});
        else makeEmptyState(empty,{icon:'＋',title:'這一天還沒有正式行程',description:'可以先處理待排預約，或依權限手動建立臨時行程。',actions:[{label:'處理待排預約',kind:'outline',run:()=>jumpToView('dispatch-home')},...($('#openCreateTripBtn')?[{label:'建立手動行程',kind:'primary',run:()=>clickExisting('#openCreateTripBtn')}]:[])]});
      }
    }
    $$('.empty',root).forEach(el=>{
      const text=el.textContent.trim();
      if(text==='目前沒有異常')makeEmptyState(el,{icon:'✓',title:'目前沒有未結異常',description:'目前所有行程都沒有需要調度人員接手的異常事件。',actions:[{label:'查看全部行程',kind:'outline',run:()=>jumpToView('dispatch-trips')}]});
      else if(text.includes('目前沒有 補助規則集')||text.includes('目前沒有補助規則集'))makeEmptyState(el,{icon:'補',title:'尚未建立補助規則',description:'系統不會自行假造政府補助內容。請由有權限的管理者依官方來源建立規則。',actions:[$('#openBenefitRulesetBtn')?{label:'新增補助規則',kind:'primary',run:()=>clickExisting('#openBenefitRulesetBtn')}:{label:'重新整理',kind:'outline',run:()=>location.reload()}]});
      else if(text==='目前還沒有需求者')makeEmptyState(el,{icon:'人',title:'目前還沒有需求者',description:'需求者可用手機號碼自行註冊；公司工作者也可另外增加需求者身分。',actions:[]});
      else if(text==='此組織目前沒有成員')makeEmptyState(el,{icon:'＋',title:'此組織尚未新增成員',description:'先新增負責人、調度人員或司機，之後才能進行完整的公司營運設定。',actions:[$('#openAddStaffBtn')?{label:'新增組織成員',kind:'primary',run:()=>clickExisting('#openAddStaffBtn')}:{label:'返回組織管理',kind:'outline',run:()=>jumpToView('platform-organizations')}]});
      else if(text==='目前沒有有效組織')makeEmptyState(el,{icon:'＋',title:'目前沒有有效組織',description:'建立第一個合作公司或長照機構後，才能開始設定人員、車輛與營運資料。',actions:[$('#openAddOrganizationBtn')?{label:'新增組織',kind:'primary',run:()=>clickExisting('#openAddOrganizationBtn')}:{label:'前往組織管理',kind:'outline',run:()=>jumpToView('platform-organizations')}]});
    });
  }

  function addRiskNote(modalId,kind,text){
    const panel=$(`#${modalId} .modal-panel`);if(!panel)return;let note=$('.p3-risk-note',panel);if(!note){note=document.createElement('div');const hint=$('.smart-modal-hint',panel)||panel.querySelector('.danger-confirm-fields');(hint||panel.querySelector('.modal-actions'))?.insertAdjacentElement(hint?'afterend':'beforebegin',note);}if(!note)return;note.className=`p3-risk-note ${kind}`;note.textContent=text;
  }
  function enhanceRiskDialogs(){
    const org=$('#organizationStatusModal');if(org?.classList.contains('open')){const removing=$('#organizationStatusTitle')?.textContent.includes('停用');if(removing)addRiskNote('organizationStatusModal','reversible','可恢復操作：停用後資料、歷史行程、成員與車輛都會保留，之後可由平台超級管理者重新啟用。');}
    const revoke=$('#revokeMembershipModal');if(revoke?.classList.contains('open'))addRiskNote('revokeMembershipModal','destructive','帳號層級操作：撤銷的是目前公司的工作身分，不會刪除使用者本人或既有歷史紀錄。');
    const veh=$('#vehicleLifecycleModal');if(veh?.classList.contains('open')){const deleting=$('#vehicleLifecycleTitle')?.textContent.includes('刪除');addRiskNote('vehicleLifecycleModal','permanent',deleting?'永久操作：刪除後不保留這筆車輛主檔，只有從未使用的誤建車輛可以執行。':'永久營運狀態：退役後不可再派車且不可恢復，但所有歷史行程仍保留原車輛資訊。');}
  }

  function enhanceLongActions(root=document){
    // Generic double-click protection for selected actions whose handlers may be async or expensive.
    $$('[id="benefitQuickRunBtn"],#syncCustomerBookingsBtn,#runFleetOptimizerBtn',root).forEach(btn=>{
      if(btn.dataset.p3BusyBound==='1')return;btn.dataset.p3BusyBound='1';
      btn.addEventListener('click',()=>{if(btn.id==='benefitQuickRunBtn'&&!btn.getAttribute('aria-busy'))btn.setAttribute('aria-live','polite');},{passive:true});
    });
  }

  function enhance(root=document){enhanceEmptyStates(root);enhanceRiskDialogs();enhanceLongActions(root);}
  function init(){enhance(document);let pending=false;const root=$('#contentRoot');if(root)new MutationObserver(()=>{if(pending)return;pending=true;requestAnimationFrame(()=>{pending=false;enhance(root);});}).observe(root,{childList:true,subtree:true});$$('.modal').forEach(m=>new MutationObserver(()=>enhanceRiskDialogs()).observe(m,{attributes:true,attributeFilter:['class']}));}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
