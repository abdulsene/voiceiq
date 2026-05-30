import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { getLocations } from "../lib/api";

export interface Location {
  id: string;
  business_id: string;
  location_name: string;
  address: string;
  phone_number: string;
  agent_id: string;
  agent_name: string;
  voice_id: string;
  timezone: string;
  business_hours: any;
  is_primary: boolean;
  active: boolean;
  created_at: string;
}

interface LocationContextType {
  locations: Location[];
  selectedLocationId: string;
  setSelectedLocationId: (id: string) => void;
  selectedLocation: Location | null;
  loading: boolean;
  refresh: () => void;
  hasMultipleLocations: boolean;
}

const LocationContext = createContext<LocationContextType>({
  locations: [],
  selectedLocationId: "all",
  setSelectedLocationId: () => {},
  selectedLocation: null,
  loading: true,
  refresh: () => {},
  hasMultipleLocations: false,
});

export function LocationProvider({ children }: { children: ReactNode }) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState<string>("all");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    const token = localStorage.getItem("neverr_token");
    if (!token) { setLoading(false); return; }
    getLocations()
      .then((d) => {
        const locs = d?.locations || [];
        setLocations(locs);
        if (locs.length === 1) {
          setSelectedLocationId(locs[0].id);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const selectedLocation = selectedLocationId === "all"
    ? null
    : locations.find((l) => l.id === selectedLocationId) || null;

  return (
    <LocationContext.Provider value={{
      locations,
      selectedLocationId,
      setSelectedLocationId,
      selectedLocation,
      loading,
      refresh,
      hasMultipleLocations: locations.length > 1,
    }}>
      {children}
    </LocationContext.Provider>
  );
}

export function useLocation() {
  return useContext(LocationContext);
}
