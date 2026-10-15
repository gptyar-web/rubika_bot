import { escapeHTML as esc } from './model.js';

export const TEMPLATE_VARIABLES = Object.freeze(['name','user_id','chat_title','bot_name','date','time']);
export function renderTemplatePreview(text, variables = {}) {
  return String(text ?? '').replace(/\{\{(name|user_id|chat_title|bot_name|date|time)\}\}|\{(name|user_id|chat_title|bot_name|date|time)\}/gu, (placeholder, doubleKey, singleKey) => {const key=doubleKey || singleKey;return variables[key] === undefined ? placeholder : String(variables[key]);});
}

// Builders create data only. No markup from a button label or template is executed.
export function mountKeypadBuilder(container, initial = {}, onChange = () => {}) {
  let type = initial.inline_keypad ? 'inline' : initial.chat_keypad ? 'normal' : 'none';
  let rows = (initial.inline_keypad?.rows || initial.chat_keypad?.rows || []).map(row => row.buttons.map(button => ({ id: button.id, button_text: button.button_text, type: 'Simple' })));
  function value() {
    if (type === 'none') return {};
    const ids = new Set();
    if (!rows.length || rows.length > 20) throw new Error('صفحه‌کلید باید ۱ تا ۲۰ ردیف داشته باشد.');
    for (const row of rows) {
      if (!row.length || row.length > 8) throw new Error('هر ردیف باید ۱ تا ۸ دکمه داشته باشد.');
      for (const button of row) {
        if (!/^[A-Za-z0-9_-]{1,64}$/u.test(button.id) || ids.has(button.id)) throw new Error('شناسهٔ دکمه‌ها باید یکتا و شامل حروف لاتین، عدد، خط تیره یا زیرخط باشد.');
        ids.add(button.id); if (!button.button_text.trim() || button.button_text.length > 100) throw new Error('متن هر دکمه باید ۱ تا ۱۰۰ نویسه داشته باشد.');
      }
    }
    const keypad = { rows: rows.map(row => ({ buttons: row.map(button => ({ ...button })) })) };
    return type === 'inline' ? { inline_keypad: keypad } : { chat_keypad: keypad, chat_keypad_type: 'New' };
  }
  function changed() { onChange(); }
  function draw() {
    container.innerHTML = `<h3 class="section-title">صفحه‌کلید پیام</h3><div class="field"><label for="keypadType">نوع صفحه‌کلید</label><select id="keypadType"><option value="none">بدون صفحه‌کلید</option><option value="normal" ${type==='normal'?'selected':''}>دکمه‌های معمولی</option><option value="inline" ${type==='inline'?'selected':''}>دکمه‌های زیر پیام (Inline)</option></select></div><div id="keypadRows">${type==='none'?'':rows.map((row,ri)=>`<fieldset class="keypad-row"><legend>ردیف ${ri+1}</legend>${row.map((button,bi)=>`<div class="keypad-button-editor"><div class="field"><label for="kp_${ri}_${bi}_text">متن دکمه ${bi+1}</label><input id="kp_${ri}_${bi}_text" data-keypad-text="${ri}:${bi}" maxlength="100" value="${esc(button.button_text)}" required></div><div class="field"><label for="kp_${ri}_${bi}_id">شناسهٔ یکتا</label><input id="kp_${ri}_${bi}_id" data-keypad-id="${ri}:${bi}" dir="ltr" maxlength="64" value="${esc(button.id)}" required></div><button type="button" class="btn small danger" data-keypad-delete="${ri}:${bi}" aria-label="حذف دکمه ${bi+1} ردیف ${ri+1}">حذف</button></div>`).join('')}<div class="row-actions"><button type="button" class="btn small" data-keypad-add="${ri}" ${row.length>=8?'disabled':''}>افزودن دکمه</button><button type="button" class="btn small danger" data-keypad-remove-row="${ri}">حذف ردیف</button></div></fieldset>`).join('')}</div>${type!=='none'?`<button type="button" class="btn small" id="keypadAddRow" ${rows.length>=20?'disabled':''}>افزودن ردیف</button><p class="field-hint">دکمه‌های Simple با شناسهٔ قابل ویرایش؛ حداکثر ۲۰ ردیف و ۸ دکمه در هر ردیف. نوع‌های دیگر دکمه نیازمند تأیید API هستند.</p>`:''}`;
    container.querySelector('#keypadType').onchange = e => { type=e.target.value;if(type!=='none'&&!rows.length)rows=[[newButton()]];draw();changed(); };
    for(const key of ['text','id'])container.querySelectorAll(`[data-keypad-${key}]`).forEach(input=>input.oninput=e=>{const [ri,bi]=e.target.dataset[key==='text'?'keypadText':'keypadId'].split(':').map(Number);rows[ri][bi][key==='text'?'button_text':'id']=e.target.value;changed();});
    container.querySelectorAll('[data-keypad-delete]').forEach(button=>button.onclick=()=>{const [ri,bi]=button.dataset.keypadDelete.split(':').map(Number);rows[ri].splice(bi,1);if(!rows[ri].length)rows.splice(ri,1);draw();changed();});
    container.querySelectorAll('[data-keypad-add]').forEach(button=>button.onclick=()=>{rows[Number(button.dataset.keypadAdd)].push(newButton());draw();changed();});
    container.querySelectorAll('[data-keypad-remove-row]').forEach(button=>button.onclick=()=>{rows.splice(Number(button.dataset.keypadRemoveRow),1);draw();changed();});
    const add=container.querySelector('#keypadAddRow');if(add)add.onclick=()=>{rows.push([newButton()]);draw();changed();};
  }
  function newButton() { return { id: crypto.randomUUID(), button_text: '', type:'Simple' }; }
  draw(); return { value, set(next = {}) { type=next.inline_keypad?'inline':next.chat_keypad?'normal':'none';rows=(next.inline_keypad?.rows || next.chat_keypad?.rows || []).map(row=>row.buttons.map(button=>({...button,type:'Simple'})));draw(); }, preview() { return type==='none'?[]:rows.map(row=>row.map(button=>button.button_text)); } };
}

export function mountFlowBuilder(container, initial = []) {
  let steps=initial.map(step=>({...step,options:[...(step.options || [])]}));
  function draw() {
    container.innerHTML=`<h3 class="section-title">گام‌های گفت‌وگو</h3><p class="field-hint">کاربر با /confirm رضایت می‌دهد؛ /cancel نشست را پاک می‌کند. اطلاعات حساس درخواست نکنید.</p>${steps.map((step,i)=>`<fieldset class="keypad-row"><legend>گام ${i+1}</legend><div class="form-grid"><div class="field"><label for="flow_${i}_key">نام پاسخ</label><input id="flow_${i}_key" data-step="${i}" data-prop="key" value="${esc(step.key)}" pattern="[A-Za-z][A-Za-z0-9_]{0,39}" maxlength="40" required></div><div class="field"><label for="flow_${i}_validation">اعتبارسنجی</label><select id="flow_${i}_validation" data-step="${i}" data-prop="validation">${['text','number','email','choice'].map(type=>`<option value="${type}" ${step.validation===type?'selected':''}>${({text:'متن',number:'عدد',email:'ایمیل',choice:'انتخاب'})[type]}</option>`).join('')}</select></div></div><div class="field"><label for="flow_${i}_prompt">پرسش</label><textarea id="flow_${i}_prompt" data-step="${i}" data-prop="prompt" maxlength="1000" required>${esc(step.prompt)}</textarea></div><div class="field"><label for="flow_${i}_options">گزینه‌ها برای نوع انتخاب (هر خط یک گزینه)</label><textarea id="flow_${i}_options" data-step="${i}" data-prop="options" maxlength="1000">${esc((step.options||[]).join('\n'))}</textarea></div><button type="button" class="btn small danger" data-delete-step="${i}">حذف گام</button></fieldset>`).join('')}<button type="button" class="btn small" id="addFlowStep" ${steps.length>=20?'disabled':''}>افزودن گام</button>`;
    container.querySelectorAll('[data-step]').forEach(input=>input.oninput=e=>{const step=steps[Number(e.target.dataset.step)];step[e.target.dataset.prop]=e.target.dataset.prop==='options'?e.target.value.split('\n').map(v=>v.trim()).filter(Boolean):e.target.value;});
    container.querySelectorAll('[data-delete-step]').forEach(button=>button.onclick=()=>{steps.splice(Number(button.dataset.deleteStep),1);draw();});
    container.querySelector('#addFlowStep').onclick=()=>{steps.push({id:crypto.randomUUID(),key:`answer_${steps.length+1}`,prompt:'',validation:'text',options:[]});draw();};
  }
  draw(); return { value() { if(!steps.length)throw new Error('دست‌کم یک گام به گفت‌وگو اضافه کنید.');const keys=new Set();for(const step of steps){if(!step.prompt.trim()||!/^[A-Za-z][A-Za-z0-9_]{0,39}$/u.test(step.key)||keys.has(step.key))throw new Error('پرسش و نام یکتای پاسخ هر گام را کامل کنید.');keys.add(step.key);if(step.validation==='choice'&&(step.options.length<2||step.options.length>8||new Set(step.options).size!==step.options.length))throw new Error('گام انتخابی باید ۲ تا ۸ گزینهٔ یکتا داشته باشد.');}return steps.map(step=>({...step,...(step.validation==='choice'?{options:[...step.options]}:{options:[]})})); } };
}

export function mountMenuBuilder(container, initial = []) {
  let items=structuredClone(initial);
  const at=path=>{const indexes=path.split('.').map(Number);let list=items;for(let i=0;i<indexes.length-1;i++)list=list[indexes[i]].children;return {list,index:indexes.at(-1),item:list[indexes.at(-1)]};};
  const count=list=>list.reduce((sum,item)=>sum+1+count(item.children || []),0);
  const make=()=>({id:crypto.randomUUID(),text:'',response:''});
  function markup(list,path='',depth=1) { return list.map((item,index)=>{const key=path?`${path}.${index}`:String(index);return `<fieldset class="keypad-row menu-item"><legend>گزینه ${index+1} · سطح ${depth}</legend><div class="field"><label for="menu_${key}_text">عنوان دکمه</label><input id="menu_${key}_text" data-menu-path="${key}" data-menu-prop="text" maxlength="100" value="${esc(item.text)}" required></div><div class="field"><label for="menu_${key}_id">شناسه یکتا</label><input id="menu_${key}_id" data-menu-path="${key}" data-menu-prop="id" dir="ltr" maxlength="40" value="${esc(item.id)}" required></div><div class="field"><label for="menu_${key}_response">پاسخ این گزینه</label><textarea id="menu_${key}_response" data-menu-path="${key}" data-menu-prop="response" maxlength="4000">${esc(item.response || '')}</textarea></div>${markup(item.children || [],key,depth+1)}<div class="row-actions"><button type="button" class="btn small" data-menu-add-child="${key}" ${depth>=4||count(items)>=100?'disabled':''}>افزودن زیرمنو</button><button type="button" class="btn small danger" data-menu-delete="${key}">حذف گزینه</button></div></fieldset>`;}).join(''); }
  function draw() {
    container.innerHTML=`<h3 class="section-title">سازنده منوی سلسله‌مراتبی</h3><p class="field-hint">حداکثر چهار سطح و ۱۰۰ گزینه. موتور، منوهای طولانی را صفحه‌بندی می‌کند.</p>${markup(items)}<button type="button" class="btn small" id="addMenuItem" ${count(items)>=100?'disabled':''}>افزودن گزینه اصلی</button>`;
    container.querySelectorAll('[data-menu-path]').forEach(input=>input.oninput=e=>{at(e.target.dataset.menuPath).item[e.target.dataset.menuProp]=e.target.value;});
    container.querySelectorAll('[data-menu-add-child]').forEach(button=>button.onclick=()=>{const item=at(button.dataset.menuAddChild).item;item.children ||= [];item.children.push(make());draw();});
    container.querySelectorAll('[data-menu-delete]').forEach(button=>button.onclick=()=>{const {list,index}=at(button.dataset.menuDelete);list.splice(index,1);draw();});
    container.querySelector('#addMenuItem').onclick=()=>{items.push(make());draw();};
  }
  draw();return { value() { const ids=new Set();function validate(list){for(const item of list){if(!item.text.trim()||!/^[A-Za-z0-9_-]{1,40}$/u.test(item.id)||ids.has(item.id))throw new Error('عنوان و شناسهٔ یکتای گزینه‌های منو را کامل کنید.');ids.add(item.id);if(!item.children?.length&&!item.response?.trim())throw new Error('گزینهٔ بدون زیرمنو باید پاسخ داشته باشد.');validate(item.children || []);}}if(!items.length)throw new Error('دست‌کم یک گزینه به منو اضافه کنید.');validate(items);const clean=list=>list.map(item=>{const copy={...item};if(copy.children?.length){copy.children=clean(copy.children);if(!copy.response?.trim())delete copy.response;}else delete copy.children;return copy;});return clean(items); } };
}
