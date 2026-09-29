(() => {
  'use strict';
  const q=(sel,root=document)=>root.querySelector(sel);
  const qa=(sel,root=document)=>[...root.querySelectorAll(sel)];
  const interactive='button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';
  let lastModalTrigger=null;

  function setupLandmarks(){
    if(!q('.skip-link')){
      const a=document.createElement('a');a.className='skip-link';a.href='#contentRoot';a.textContent='跳到主要內容';document.body.prepend(a);
    }
    const root=q('#contentRoot');if(root){root.setAttribute('role','main');root.setAttribute('tabindex','-1');}
    const toast=q('#toast');if(toast){toast.setAttribute('role','status');toast.setAttribute('aria-live','polite');toast.setAttribute('aria-atomic','true');}
    if(!q('#uxPageAnnouncer')){
      const live=document.createElement('div');live.id='uxPageAnnouncer';live.className='sr-only';live.setAttribute('aria-live','polite');live.setAttribute('aria-atomic','true');document.body.appendChild(live);
    }
  }

  function setupLogin(){
    const card=q('.login-card');if(!card)return;
    const grid=card.querySelector('.form-grid');
    if(grid&&!card.querySelector('.login-section-label')){
      const label=document.createElement('div');label.className='login-section-label';label.textContent='使用手機號碼登入';grid.parentNode.insertBefore(label,grid);
    }
    const password=q('#loginPassword');
    if(password&&!q('#loginPasswordToggle')){
      const field=password.closest('.form-field');field?.classList.add('password-field');
      const btn=document.createElement('button');btn.type='button';btn.id='loginPasswordToggle';btn.className='password-toggle';btn.textContent='顯示';btn.setAttribute('aria-label','顯示密碼');
      btn.addEventListener('click',()=>{const show=password.type==='password';password.type=show?'text':'password';btn.textContent=show?'隱藏':'顯示';btn.setAttribute('aria-label',show?'隱藏密碼':'顯示密碼');password.focus();});
      field?.appendChild(btn);
    }
  }

  function enhanceNavA11y(){
    qa('.nav-btn').forEach(btn=>{if(btn.classList.contains('active'))btn.setAttribute('aria-current','page');else btn.removeAttribute('aria-current');});
    qa('.wizard-step-indicator').forEach(btn=>{if(btn.classList.contains('active'))btn.setAttribute('aria-current','step');else btn.removeAttribute('aria-current');});
    qa('.icon-btn[data-close]').forEach(btn=>{if(!btn.getAttribute('aria-label'))btn.setAttribute('aria-label','關閉視窗');});
    qa('button:disabled').forEach(btn=>btn.setAttribute('aria-disabled','true'));
  }

  function hideTechnicalDetails(root=document){
    qa('.optimizer-card .smart-modal-hint',root).forEach(box=>{
      if(box.dataset.uxTech==='1'||!box.textContent.includes('先套法規與硬性限制'))return;
      box.dataset.uxTech='1';
      const d=document.createElement('details');d.className='technical-details';
      const s=document.createElement('summary');s.textContent='查看排車計算依據';
      const b=document.createElement('div');b.className='technical-details-body';
      while(box.firstChild)b.appendChild(box.firstChild);
      d.append(s,b);box.replaceWith(d);
    });
    qa('.offline-execution-banner .small',root).forEach(note=>{
      if(note.dataset.uxTech==='1')return;note.dataset.uxTech='1';
      const d=document.createElement('details');d.className='technical-details';
      const s=document.createElement('summary');s.textContent='查看離線同步說明';
      const b=document.createElement('div');b.className='technical-details-body';b.appendChild(note.cloneNode(true));
      d.append(s,b);note.replaceWith(d);
    });
  }

  function optimizeMobileActions(root=document){
    if(!window.matchMedia('(max-width:899px)').matches)return;
    qa('.mobile-table-actions',root).forEach(details=>{
      if(details.dataset.ux57==='1')return;details.dataset.ux57='1';
      const content=details.querySelector('.mobile-table-actions-content');if(!content)return;
      const controls=[...content.children].filter(el=>el.matches('button,.btn,select,a,[role="button"]'));
      if(controls.length<=2){
        const wrap=document.createElement('div');wrap.className='mobile-inline-actions';
        controls.forEach(el=>wrap.appendChild(el));details.replaceWith(wrap);return;
      }
      const primary=controls.find(el=>el.matches('.primary:not(.danger),.success'));
      if(primary){primary.classList.add('mobile-primary-row-action');details.parentNode.insertBefore(primary,details);}
    });
  }

  function announceCurrentPage(){
    const title=q('#contentRoot .page-head h2')||q('#contentRoot h2');
    const live=q('#uxPageAnnouncer');if(title&&live)live.textContent=`已開啟${title.textContent.trim()}`;
  }

  function enhanceRenderedContent(){
    const root=q('#contentRoot');if(!root)return;
    enhanceNavA11y();hideTechnicalDetails(root);optimizeMobileActions(root);announceCurrentPage();
  }

  function setupModalA11y(){
    qa('.modal').forEach(modal=>{
      const panel=modal.querySelector('.modal-panel');if(!panel)return;
      modal.setAttribute('role','presentation');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('tabindex','-1');
      const heading=panel.querySelector('.modal-head h3');if(heading){if(!heading.id)heading.id=`ux-modal-title-${modal.id}`;panel.setAttribute('aria-labelledby',heading.id);}
      new MutationObserver(()=>{
        if(modal.classList.contains('open')){
          lastModalTrigger=document.activeElement;
          setTimeout(()=>{const first=panel.querySelector(interactive);(first||panel).focus({preventScroll:true});},0);
        }else if(lastModalTrigger&&document.contains(lastModalTrigger)){setTimeout(()=>lastModalTrigger.focus?.({preventScroll:true}),0);}
      }).observe(modal,{attributes:true,attributeFilter:['class']});
    });
    document.addEventListener('keydown',e=>{
      const openModals=qa('.modal.open');const modal=openModals[openModals.length-1];if(!modal)return;
      const panel=modal.querySelector('.modal-panel');if(!panel)return;
      if(e.key==='Escape'){
        const close=modal.querySelector('[data-close]');if(close){e.preventDefault();close.click();}return;
      }
      if(e.key!=='Tab')return;
      const nodes=qa(interactive,panel).filter(el=>el.offsetParent!==null&&!el.disabled);if(!nodes.length){e.preventDefault();panel.focus();return;}
      const first=nodes[0],last=nodes[nodes.length-1];
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
      else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
    });
  }

  function setupNavigationFocus(){
    document.addEventListener('click',e=>{
      const nav=e.target.closest('[data-view],[data-ui-view]');if(!nav)return;
      setTimeout(()=>{const h=q('#contentRoot .page-head h2')||q('#contentRoot h2');if(h){h.setAttribute('tabindex','-1');h.focus({preventScroll:true});}},0);
    });
  }

  function init(){
    setupLandmarks();setupLogin();setupModalA11y();setupNavigationFocus();enhanceNavA11y();enhanceRenderedContent();
    let contentEnhancePending=false;
    const root=q('#contentRoot');if(root)new MutationObserver(()=>{if(contentEnhancePending)return;contentEnhancePending=true;requestAnimationFrame(()=>{contentEnhancePending=false;enhanceRenderedContent();});}).observe(root,{childList:true,subtree:true});
    let navEnhancePending=false;
    const nav=q('#mobileNav');if(nav)new MutationObserver(()=>{if(navEnhancePending)return;navEnhancePending=true;requestAnimationFrame(()=>{navEnhancePending=false;enhanceNavA11y();});}).observe(nav,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
    window.addEventListener('resize',()=>setTimeout(()=>optimizeMobileActions(q('#contentRoot')||document),80),{passive:true});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
