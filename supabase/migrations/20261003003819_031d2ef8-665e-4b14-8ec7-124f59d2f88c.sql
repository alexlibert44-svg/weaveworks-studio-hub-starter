REVOKE ALL ON FUNCTION public.owns_set(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.owns_word(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.owns_set(uuid), public.owns_word(uuid) TO authenticated;