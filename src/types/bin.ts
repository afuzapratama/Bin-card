export interface BinRecord {
  bin: string;
  brand: string | null;
  type: string | null;       // debit / credit / prepaid
  category: string | null;   // classic / gold / platinum / etc
  issuer: string | null;
  issuer_url: string | null;
  issuer_phone: string | null;
  country_alpha2: string | null;
  country_name: string | null;
  country_numeric: string | null;
  country_iso3: string | null;
  currency: string | null;
  is_commercial: boolean | null;
  is_prepaid: boolean | null;
}

export interface BinLookupResponse {
  success: boolean;
  data: BinRecord | null;
  message?: string;
  latency_ms: number;
}

export interface BinStatsResponse {
  total_bins: number;
  brands: Record<string, number>;
  types: Record<string, number>;
  top_countries: { country: string; count: number }[];
  last_updated: string;
}
