import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { createImageVariantConfig } from '../../util/sdkLoader';
import { isErrorUserPendingApproval, isForbiddenError, storableError } from '../../util/errors';
import { convertUnitToSubUnit, unitDivisor } from '../../util/currency';
import {
  parseDateFromISO8601,
  getExclusiveEndDate,
  addTime,
  subtractTime,
  daysBetween,
  getStartOf,
} from '../../util/dates';
import { constructQueryParamName, isOriginInUse } from '../../util/search';
import { hasPermissionToViewData, isUserAuthorized } from '../../util/userHelpers';
import { parse } from '../../util/urlHelpers';

import { addMarketplaceEntities } from '../../ducks/marketplaceData.duck';


const RESULT_PAGE_SIZE = 24;


const resultIds = data => {
  const listings = data.data;
  return listings
    .filter(l => !l.attributes.deleted && l.attributes.state === 'published')
    .map(l => l.id);
};


/**
 * FIXED: Filter listings by date overlap with search range
 * Shows listings where ANY part of their availability overlaps with search dates
 */
const filterListingsByDateOverlap = (listings, searchParams) => {
  if (!searchParams || !searchParams.dates) {
    return listings;
  }

  const dateValues = searchParams.dates.split(',');
  if (dateValues.length !== 2) {
    return listings;
  }

  try {
    const [startStr, endStr] = dateValues;
    const searchTZ = 'Etc/UTC';

    const searchStart = parseDateFromISO8601(startStr, searchTZ);
    const searchEnd = parseDateFromISO8601(endStr, searchTZ);

    if (!searchStart || !searchEnd) {
      return listings;
    }

    const searchStartTs = searchStart.getTime();
    const searchEndTs = searchEnd.getTime();

    return listings.filter(listing => {
      if (!listing || !listing.attributes) {
        return false;
      }

      const attributes = listing.attributes;

      // Check custom timeSlots (your system)
      if (attributes.timeSlots && Array.isArray(attributes.timeSlots)) {
        const hasOverlap = attributes.timeSlots.some(slot => {
          if (!slot || !slot.attributes) return false;
          const slotStart = new Date(slot.attributes.start).getTime();
          const slotEnd = new Date(slot.attributes.end).getTime();
          // OVERLAP CHECK: searchStart <= slotEnd AND searchEnd >= slotStart
          return searchStartTs <= slotEnd && searchEndTs >= slotStart;
        });
        return hasOverlap;
      }

      // Fallback: Check standard Sharetribe availabilityPlan
      if (attributes.availabilityPlan) {
        const { exceptions } = attributes.availabilityPlan;
        if (!exceptions || !Array.isArray(exceptions) || exceptions.length === 0) {
          return true;
        }
        const isCompletelyBlocked = isSearchRangeCompletelyBlocked(
          searchStartTs,
          searchEndTs,
          exceptions
        );
        return !isCompletelyBlocked;
      }

      return true;
    });
  } catch (error) {
    console.warn('Error filtering listings by date overlap:', error);
    return listings;
  }
};


const isSearchRangeCompletelyBlocked = (searchStartTs, searchEndTs, exceptions) => {
  if (!exceptions || exceptions.length === 0) {
    return false;
  }

  const sortedExceptions = exceptions
    .filter(e => e && e.attributes)
    .map(e => ({
      start: new Date(e.attributes.start).getTime(),
      end: new Date(e.attributes.end).getTime(),
    }))
    .sort((a, b) => a.start - b.start);

  if (sortedExceptions.length === 0) {
    return false;
  }

  let currentPos = searchStartTs;

  for (const exception of sortedExceptions) {
    if (exception.start > currentPos) {
      return false;
    }

    currentPos = Math.max(currentPos, exception.end);

    if (currentPos >= searchEndTs) {
      return true;
    }
  }

  return false;
};

const searchListingsPayloadCreator = ({ searchParams, config }, thunkAPI) => {
  const { dispatch, rejectWithValue, extra: sdk } = thunkAPI;

  const searchValidListingTypes = (listingTypes, listingTypePathParam, isListingTypeVariant) => {
    return isListingTypeVariant
      ? {
        pub_listingType: listingTypePathParam,
      }
      : config.listing.enforceValidListingType
        ? {
          pub_listingType: listingTypes.map(l => l.listingType),

        }
        : {};
  };

  const constructCategoryPropertiesForAPI = (queryParamPrefix, categories, level, params) => {
    const levelKey = `${queryParamPrefix}${level}`;
    const levelValue =
      typeof params?.[levelKey] !== 'undefined' ? `${params?.[levelKey]}` : undefined;
    const foundCategory = categories.find(cat => cat.id === levelValue);
    const subcategories = foundCategory?.subcategories || [];
    return foundCategory && subcategories.length > 0
      ? {
        [levelKey]: levelValue,
        ...constructCategoryPropertiesForAPI(queryParamPrefix, subcategories, level + 1, params),
      }
      : foundCategory
        ? { [levelKey]: levelValue }
        : {};
  };

  /**
   * Category filter params are prepared here. We omit invalid category names.
   * I.e. params that are not part of the currently configured category tree.
   *
   * @param {string} paramName - The name of the parameter to prepare.
   * @param {Object} params - The search params object.
   * @returns {Object} The prepared parameter object.
   */
  const prepareCategoryParams = (paramName, params) => {
    const categoryConfig = config.search.defaultFilters?.find(f => f.schemaType === 'category');
    const categories = config.categoryConfiguration.categories;
    const { key, scope } = categoryConfig || {};
    const categoryParamPrefix = constructQueryParamName(key, scope);
    return paramName.startsWith(categoryParamPrefix)
      ? constructCategoryPropertiesForAPI(categoryParamPrefix, categories, 1, params)
      : {};
  };

  const constructIntegerRangePropertyForAPI = (queryParamPrefix, params) => {
    const integerValue = params?.[queryParamPrefix];
    const [min, max] = integerValue ? integerValue.split(',') : [];
    const inclusiveMin = Number.parseInt(min, 10);
    const exclusiveMax = Number.parseInt(max, 10) + 1;



    return Number.isInteger(inclusiveMin) && Number.isInteger(exclusiveMax)
      ? { [queryParamPrefix]: [inclusiveMin, exclusiveMax].join(',') }
      : {};
  };

  /**
   * Integer range filter values are converted to API params of type 'long'.
   *
   * The range end must be exclusive. E.g. 1000,2000 -> 1000,2001
   *
   * NOTE: currently we don't validate the range values against the integer range config,
   * but we might want to do that in the future.
   *
   * @param {string} paramName - The name of the parameter to prepare.
   * @param {Object} params - The search params object.
   * @returns {Object} The prepared parameter object.
   */
  const prepareIntegerRangeParam = (paramName, params) => {
    const integerRangeConfig = config.listing.listingFields?.find(f => f.schemaType === 'long');
    const { key, scope } = integerRangeConfig || {};
    const integerParamPrefix = constructQueryParamName(key, scope);
    return paramName.startsWith(integerParamPrefix)
      ? constructIntegerRangePropertyForAPI(integerParamPrefix, params)
      : {};
  };


  const prepareAPIParams = (params, paramHandlers) => {
    const pickedKeys = Object.entries(params).reduce((picked, [k, v]) => {
      const preparedParams = paramHandlers.reduce((picked, fn) => {
        return { ...picked, ...fn(k, params) };
      }, {});

      const currentParam = Object.keys(preparedParams).length > 0 ? preparedParams : { [k]: v };

      return { ...picked, ...currentParam };
    }, {});

    return pickedKeys;
  };

  const priceSearchParams = priceParam => {
    const inSubunits = value => convertUnitToSubUnit(value, unitDivisor(config.currency));
    const values = priceParam ? priceParam.split(',') : [];
    if (!priceParam || values.length !== 2) return {};
    const nightlyMin = Math.floor(Number(values[0]) / 30);
    const nightlyMax = Math.ceil(Number(values[1]) / 30);
    return {
      price: [inSubunits(nightlyMin), inSubunits(nightlyMax) + 1].join(','),
    };
  };

  const datesSearchParams = datesParam => {
    const searchTZ = 'Etc/UTC';
    const datesFilter = config.search.defaultFilters.find(f => f.key === 'dates');
    const values = datesParam ? datesParam.split(',') : [];
    const hasValues = datesFilter && datesParam && values.length === 2;
    const { dateRangeMode, availability } = datesFilter || {};
    const isNightlyMode = dateRangeMode === 'night';
    const isEntireRangeAvailable = availability === 'time-full';

    const getProlongedStart = date => subtractTime(date, 14, 'hours', searchTZ);
    const getProlongedEnd = date => addTime(date, 12, 'hours', searchTZ);

    const startDate = hasValues ? parseDateFromISO8601(values[0], searchTZ) : null;
    const endRaw = hasValues ? parseDateFromISO8601(values[1], searchTZ) : null;
    const endDate =
      hasValues && isNightlyMode
        ? endRaw
        : hasValues
          ? getExclusiveEndDate(endRaw, searchTZ)
          : null;

    const today = getStartOf(new Date(), 'day', searchTZ);
    const possibleStartDate = subtractTime(today, 14, 'hours', searchTZ);
    const hasValidDates =
      hasValues &&
      startDate.getTime() >= possibleStartDate.getTime() &&
      startDate.getTime() <= endDate.getTime();

    const dayCount = daysBetween(startDate, endDate);
    const day = 1440;
    const hour = 60;
    const MIN_STAY_DAYS = 30;

    const minDuration = Math.max(dayCount * day - hour, MIN_STAY_DAYS * day - hour);

    console.log('Search params sent to API:', {
      dayCount,
      minDuration,
      minDurationInDays: minDuration / 1440,
      start: startDate,
      end: endDate,
    });


    return {};
  };

  const stockFilters = datesMaybe => {
    const hasDatesFilterInUse = Object.keys(datesMaybe).length > 0;

    return hasDatesFilterInUse ? {} : { minStock: 1, stockMode: 'match-undefined' };
  };

  const seatsSearchParams = (seats, datesMaybe) => {
    const seatsFilter = config.search.defaultFilters.find(f => f.key === 'seats');
    const hasDatesFilterInUse = Object.keys(datesMaybe).length > 0;

    return hasDatesFilterInUse && seatsFilter ? { seats } : {};
  };

  const sortSearchParams = (sortParam, hasKeywords) => {
    const sortConfig = config?.search?.sortConfig || {};
    const defaultSort = sortConfig?.options?.[0]?.key;
    const relevanceEnabled = sortConfig.options?.some(
      option => option.key === sortConfig.relevanceKey
    );

    if (sortParam !== undefined && sortParam !== sortConfig.relevanceKey) {
      return { sort: sortParam };
    }

    if (relevanceEnabled && (hasKeywords || !sortConfig.active)) {
      return {};
    }

    return { sort: defaultSort };
  };

  const {
    perPage,
    price,
    dates,
    seats,
    sort,
    mapSearch,
    listingTypePathParam,
    isListingTypeVariant,
    ...restOfParams
  } = searchParams;

  const priceMaybe = priceSearchParams(price);
  const datesMaybe = datesSearchParams(dates);
  const stockMaybe = stockFilters(datesMaybe);
  const seatsMaybe = seatsSearchParams(seats, datesMaybe);
  const sortMaybe = sortSearchParams(sort, searchParams?.keywords !== undefined);

  const params = {

    ...prepareAPIParams(restOfParams, [prepareCategoryParams, prepareIntegerRangeParam]),

    ...searchValidListingTypes(
      config.listing.listingTypes,
      listingTypePathParam,
      isListingTypeVariant
    ),
    ...priceMaybe,
    ...datesMaybe,
    ...stockMaybe,
    ...seatsMaybe,
    ...sortMaybe,
    perPage,
  };

  return sdk.listings
    .query(params)
    .then(response => {
      const listingFields = config?.listing?.listingFields;
      const sanitizeConfig = { listingFields };

      dispatch(addMarketplaceEntities(response, sanitizeConfig));
      return response;
    })
    .catch(e => {
      const error = storableError(e);
      if (!(isErrorUserPendingApproval(error) || isForbiddenError(error))) {
        return rejectWithValue(error);
      }
      return rejectWithValue(error);
    });
};

export const searchListings = createAsyncThunk(
  'SearchPage/searchListings',
  searchListingsPayloadCreator
);


const searchPageSlice = createSlice({
  name: 'SearchPage',
  initialState: {
    pagination: null,
    searchParams: null,
    searchInProgress: false,
    searchListingsError: null,
    currentPageResultIds: [],
    activeListingId: null,
  },
  reducers: {
    setActiveListing: (state, action) => {
      state.activeListingId = action.payload;
    },
  },
  extraReducers: builder => {
    builder
      .addCase(searchListings.pending, (state, action) => {
        state.searchParams = action.meta.arg.searchParams;
        state.searchInProgress = true;
        state.searchListingsError = null;
      })
      .addCase(searchListings.fulfilled, (state, action) => {
        // FIXED: Apply frontend filtering for date overlap
        const filteredListings = filterListingsByDateOverlap(
          action.payload.data,
          state.searchParams
        );
        state.currentPageResultIds = resultIds(filteredListings);
        state.pagination = action.payload.data.meta;
        state.searchInProgress = false;
      })
      .addCase(searchListings.rejected, (state, action) => {
        console.error(action.payload);
        state.searchInProgress = false;
        state.searchListingsError = action.payload;
      });
  },
});

export const { setActiveListing } = searchPageSlice.actions;

export default searchPageSlice.reducer;


export const loadData = (params, search, config) => (dispatch, getState, sdk) => {
  const { listingType: listingTypePathParam } = params || {};
  const state = getState();
  const currentUser = state.user?.currentUser;
  const isAuthorized = currentUser && isUserAuthorized(currentUser);
  const hasViewingRights = currentUser && hasPermissionToViewData(currentUser);
  const isPrivateMarketplace = config.accessControl.marketplace.private === true;
  const canFetchData =
    !isPrivateMarketplace || (isPrivateMarketplace && isAuthorized && hasViewingRights);
  if (!canFetchData) {
    return Promise.resolve();
  }

  const queryParams = parse(search, {
    latlng: ['origin'],
    latlngBounds: ['bounds'],
  });

  const { page = 1, address, origin, ...rest } = queryParams;
  const originMaybe = isOriginInUse(config) && origin ? { origin } : {};

  const listingTypeVariantMaybe = listingTypePathParam
    ? { listingTypePathParam, isListingTypeVariant: true }
    : {};

  const {
    aspectWidth = 1,
    aspectHeight = 1,
    variantPrefix = 'listing-card',
  } = config.layout.listingImage;
  const aspectRatio = aspectHeight / aspectWidth;

  const searchListingsCall = searchListings({
    searchParams: {
      ...rest,
      ...originMaybe,
      ...listingTypeVariantMaybe,
      page,
      perPage: RESULT_PAGE_SIZE,
      include: ['author', 'images'],
      'fields.listing': [
        'title',
        'geolocation',
        'price',
        'deleted',
        'state',
        'publicData.listingType',
        'publicData.transactionProcessAlias',
        'publicData.unitType',
        'publicData.cardStyle',

        'publicData.pickupEnabled',
        'publicData.shippingEnabled',
        'publicData.priceVariationsEnabled',
        'publicData.priceVariants',
      ],
      'fields.user': ['profile.displayName', 'profile.abbreviatedName'],
      'fields.image': [
        'variants.scaled-small',
        'variants.scaled-medium',
        `variants.${variantPrefix}`,
        `variants.${variantPrefix}-2x`,
      ],
      ...createImageVariantConfig(`${variantPrefix}`, 400, aspectRatio),
      ...createImageVariantConfig(`${variantPrefix}-2x`, 800, aspectRatio),
      'limit.images': 1,
    },
    config,
  });

  return dispatch(searchListingsCall);
};
