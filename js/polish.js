(()=>{
  'use strict';
  const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
  function clickExisting(selector){const el=$(selector);if(el&&!el.disabled){el.click();return true;}return false;}
  function jumpToView(view){const target=$(`[data-view="${view}"]`)||$(`[data-ui-view="${view}"]`);target?.click();}

  function makeEmptyState(el,{icon='○',title,description,actions=[]}){
    if(!el||el.dataset.p3Empty==='1')return;el.dataset.p3Empty='1';
    el.classList.add('p3-empty-state');el.classList.remove('empty');
    el.innerHTML=`<div class="p3-empty-icon" aria-hidden="true">${icon}</div><h3>${title}</h3>${description?`<p>${description}</p>`:''}${actions.length?`<div class="p3-empty-actions">${actions.map((a,i)=>`<button class="btn ${a.kind||'outline'}" type="button" data-p3-action="${i}">${a.label}</button>`).join('')}</div>`:''}`;
    actions.forEach((a,i)=>el.querySelector(`[data-p3-action="${i}"]`)?.addEventListener('click',a.run));
  }

  function enhanceEmptyStates(root=document){
    // Dispatch: distinguish "no records" from "filters returned zero".
    const summary=$('#dispatchFilterSummary',root)||$('#dispatchFilterSummary');
    if(summary){
      const m=summary.textContent.match(/顯示\s*(\d+)\s*\/\s*(\d+)/);const shown=Number(m?.[1]),total=Number(m?.[2]);
      const empty=$('#dispatchTripRows .empty',root)||$('#dispatchTripRows .empty');
      if(empty&&shown===0){
        if(total>0)makeEmptyState(empty,{icon:'⌕',title:'沒有符合篩選的行程',description:'',actions:[{label:'清除篩選',kind:'primary',run:()=>clickExisting('#clearTripFiltersBtn')}]});
        else makeEmptyState(empty,{icon:'＋',title:'這一天沒有行程',description:'',actions:[{label:'看待排預約',kind:'outline',run:()=>jumpToView('dispatch-home')},...($('#openCreateTripBtn')?[{label:'手動排車',kind:'primary',run:()=>clickExisting('#openCreateTripBtn')}]:[])]});
      }
    }
    $$('.empty',root).forEach(el=>{
      const text=el.textContent.trim();
      if(text==='目前沒有異常')makeEmptyState(el,{icon:'✓',title:'沒有異常',description:'',actions:[]});
      else if(text.includes('目前沒有 補助規則集')||text.includes('目前沒有補助規則集'))makeEmptyState(el,{icon:'補',title:'還沒有補助規則',description:'',actions:[$('#openBenefitRulesetBtn')?{label:'新增補助規則',kind:'primary',run:()=>clickExisting('#openBenefitRulesetBtn')}:{label:'重新整理',kind:'outline',run:()=>location.reload()}]});
      else if(text==='目前還沒有需求者')makeEmptyState(el,{icon:'人',title:'還沒有需求者',description:'',actions:[]});
      else if(text==='此機構目前沒有成員')makeEmptyState(el,{icon:'＋',title:'還沒有成員',description:'',actions:[$('#openAddStaffBtn')?{label:'新增成員',kind:'primary',run:()=>clickExisting('#openAddStaffBtn')}:{label:'返回機構管理',kind:'outline',run:()=>jumpToView('platform-organizations')}]});
      else if(text==='目前沒有有效機構')makeEmptyState(el,{icon:'＋',title:'還沒有機構',description:'',actions:[$('#openAddOrganizationBtn')?{label:'新增機構',kind:'primary',run:()=>clickExisting('#openAddOrganizationBtn')}:{label:'前往機構管理',kind:'outline',run:()=>jumpToView('platform-organizations')}]});
    });
  }

  function addRiskNote(modalId,kind,text){
    const panel=$(`#${modalId} .modal-panel`);if(!panel)return;let note=$('.p3-risk-note',panel);if(!note){note=document.createElement('div');const hint=$('.smart-modal-hint',panel)||panel.querySelector('.danger-confirm-fields');(hint||panel.querySelector('.modal-actions'))?.insertAdjacentElement(hint?'afterend':'beforebegin',note);}if(!note)return;note.className=`p3-risk-note ${kind}`;note.textContent=text;
  }
  function enhanceRiskDialogs(){
    const revoke=$('#revokeMembershipModal');if(revoke?.classList.contains('open'))addRiskNote('revokeMembershipModal','destructive','只撤銷在本機構的工作身分，不會刪除這個人的帳號與紀錄。');
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
