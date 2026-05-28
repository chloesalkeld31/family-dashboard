import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://ccbtrvbwggsrlxkqkess.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNjYnRydmJ3Z2dzcmx4a3FrZXNzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5ODQzNTQsImV4cCI6MjA5NTU2MDM1NH0.OywSaKbie5cT-tHy0129PR2HckbNv8RzQqhCEAKIW8I'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
