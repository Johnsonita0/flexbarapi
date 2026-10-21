begin;

alter table public.business_settings
  drop constraint if exists business_settings_geofence_radius_m_check,
  drop constraint if exists business_settings_geofence_qr_radius_m_check;

update public.business_settings
set geofence_radius_m = 25
where geofence_radius_m <> 25;

alter table public.business_settings
  alter column geofence_radius_m set default 25,
  add constraint business_settings_geofence_radius_m_check
    check (geofence_radius_m = 25);

commit;
