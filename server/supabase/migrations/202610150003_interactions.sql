-- Additional versioned resources retain existing rows and require the same private service role.
begin;
alter table public.rubika_panel_v3_resources drop constraint if exists rubika_panel_v3_resources_collection_check;
alter table public.rubika_panel_v3_resources add constraint rubika_panel_v3_resources_collection_check
check (collection in ('drafts','templates','automations','schedules','tickets','users','violations','consents','commands','faq','flows','menus','subscribers'));
commit;
