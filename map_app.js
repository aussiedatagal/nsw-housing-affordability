// Data file paths
const GEOJSON_PATH = './data/POA_2021_NSW.geojson';
const SUBURBS_PATH = './data/postcode_to_suburbs.csv';
const AGGREGATED_DATA_PATH = './data/aggregated_yearly_data.csv';

// =============================================================================
// DEFAULT VALUES AND INFLATION RATES
// =============================================================================
// All default values are sourced from official ABS data and adjusted for inflation
// to current values using compound inflation calculations.

// ABS Inflation rates by year (as percentages)
const INFLATION_RATES = {
    2020: 0.9,   // 2020-21
    2021: 2.9,   // 2021-22
    2022: 6.6,   // 2022-23
    2023: 5.6,   // 2023-24
    2024: 3.16,  // 2024-25
    2025: 2.10   // 2025-26 (projected)
};

// Base values from official ABS sources (before inflation adjustment)
const DEFAULT_VALUES = {
    // Household Income: ABS median equivalised disposable household income
    // Source: ABS Measuring What Matters - Household income and wealth
    // URL: https://www.abs.gov.au/statistics/measuring-what-matters/measuring-what-matters-themes-and-indicators/prosperous/household-income-and-wealth
    householdIncome: {
        base: 61984,        // 2022-23 value ($1,192/week)
        baseYear: 2022,
        targetYear: 2025,
        description: "ABS median equivalised disposable household income"
    },

    // Cost of Living: ABS Household Expenditure Survey (HES) 2019-20
    // Source: ABS Household Expenditure Survey 2019-20
    // Adjusted for inflation to 2024 values (converted to weekly)
    costOfLiving: {
        utilities: {
            base: 46,       // 2019-20 weekly value (200/52*12)
            baseYear: 2019,
            targetYear: 2024,
            description: "ABS HES 2019-20 utilities expenditure"
        },
        food: {
            base: 92,       // 2019-20 weekly value (400/52*12)
            baseYear: 2019,
            targetYear: 2024,
            description: "ABS HES 2019-20 food & groceries expenditure"
        },
        transport: {
            base: 69,       // 2019-20 weekly value (300/52*12)
            baseYear: 2019,
            targetYear: 2024,
            description: "ABS HES 2019-20 transport expenditure"
        }
    },

    // Mortgage Settings: Current market rates and typical defaults
    mortgage: {
        interestRate: 6.5,      // Current market rate
        loanTerm: 30,           // Standard loan term
        depositPercent: 20,     // Standard deposit percentage
        depositAmount: 100000   // Default deposit amount
    },

    // Owner Costs: Typical NSW property ownership costs (weekly)
    ownerCosts: {
        strata: 92,         // Weekly strata/body corp (apartments)
        council: 46,        // Weekly council rates
        water: 23,          // Weekly water & sewer
        maintenance: 69     // Weekly maintenance (1% of property value annually)
    }
};

class HousingAffordabilityMap {
    constructor() {
        // Map and data state
        this.map = null;
        this.geojsonData = null;
        this.housingData = {};
        this.suburbLookup = {};
        this.sortedDataList = [];
        this.openPostcode = null;
        this.geojsonLayer = null;
        this.activePopupLayer = null;

        // User settings
        this.housingType = 'rent'; // 'rent' or 'buy'
        this.depositType = 'percent';
        this.mortgageType = 'PI';

        // Layer styling
        this.defaultStyle = { weight: 1, opacity: 1, color: 'white', fillOpacity: 0.7 };
        this.highlightStyle = { weight: 3, color: '#333', fillOpacity: 1 };

        this._initialize();
    }

    async _initialize() {
        this._initMap();
        this._bindEventListeners();
        try {
            await this._loadData();
            this.updateMapAndTable();
        } catch (error) {
            console.error("Initialization failed:", error);
        }
    }

    _initMap() {
        this.map = L.map('map').setView([-33, 149], 6);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap contributors'
        }).addTo(this.map);

        this._addLegend();
        this.map.on('popupclose', () => {
            this.openPostcode = null;
            this.activePopupLayer = null;
        });
    }

    _bindEventListeners() {
        // Income calculation
        document.getElementById('annualIncome').addEventListener('input', () => this._updateNetIncome());

        // Housing type toggle
        document.querySelectorAll('input[name="housingType"]').forEach(radio => {
            radio.addEventListener('change', (event) => this._handleHousingTypeChange(event.target.value));
        });

        // Mortgage settings
        const mortgageControls = ['interestRate', 'loanTerm', 'depositPercent', 'depositAmount'];
        mortgageControls.forEach(id => {
            document.getElementById(id).addEventListener('input', () => this.updateMapAndTable());
        });

        document.getElementById('mortgageType').addEventListener('change', (event) => this._handleMortgageTypeChange(event.target.value));

        document.querySelectorAll('input[name="depositType"]').forEach(radio => {
            radio.addEventListener('change', (event) => this._handleDepositTypeChange(event.target.value));
        });

        // Living costs
        const livingCostControls = ['utilities', 'food', 'transport', 'other', 'strata', 'council', 'water', 'maintenance'];
        livingCostControls.forEach(id => {
            document.getElementById(id).addEventListener('input', () => this.updateMapAndTable());
        });

        // Price point selector
        document.getElementById('pricePoint').addEventListener('change', () => this.updateMapAndTable());


        this._setupCollapsibleControls();
        this._setupMobilePopup();
        this._setupWindowResize();
        this._setupHeaderToggle();

        // Set default values with proper inflation adjustment
        this._setDefaultValues();

        // Initial calculations
        this._updateNetIncome();
    }

    async _loadData() {
        const [geojson, suburbs, affordability] = await Promise.all([
            fetch(GEOJSON_PATH).then(res => res.json()),
            this._loadCsv(SUBURBS_PATH),
            this._loadCsv(AGGREGATED_DATA_PATH)
        ]);

        this.geojsonData = geojson;

        affordability.forEach(item => {
            const postcode = String(item.Postcode);
            if (postcode && postcode !== 'null') {
                this.housingData[postcode] = item;
            }
        });

        suburbs.forEach(item => {
            const postcode = String(item.Postcode);
            if (postcode && postcode !== 'null' && item.Suburbs) {
                this.suburbLookup[postcode] = item.Suburbs;
            }
        });
    }

    _loadCsv(path) {
        return new Promise((resolve, reject) => {
            Papa.parse(path, {
                download: true,
                header: true,
                dynamicTyping: true,
                skipEmptyLines: true,
                complete: (results) => resolve(results.data),
                error: (err) => reject(new Error(`CSV parsing error for ${path}: ${err.message}`))
            });
        });
    }

    // Inflation adjustment function for consistent calculations across all metrics
    _adjustForInflation(baseValue, baseYear, targetYear, inflationRates) {
        let adjustedValue = baseValue;
        for (let year = baseYear + 1; year <= targetYear; year++) {
            if (inflationRates[year]) {
                adjustedValue *= (1 + inflationRates[year] / 100);
            }
        }
        return Math.round(adjustedValue);
    }


    _setDefaultValues() {
        // Set household income default (net input)
        const householdIncome = DEFAULT_VALUES.householdIncome;
        const adjustedNetIncome = this._adjustForInflation(
            householdIncome.base, 
            householdIncome.baseYear, 
            householdIncome.targetYear, 
            INFLATION_RATES
        );
        document.getElementById('annualIncome').value = Math.round(adjustedNetIncome);

        // Set cost of living defaults
        Object.entries(DEFAULT_VALUES.costOfLiving).forEach(([field, data]) => {
            const adjusted = this._adjustForInflation(
                data.base, 
                data.baseYear, 
                data.targetYear, 
                INFLATION_RATES
            );
            document.getElementById(field).value = adjusted;
        });

        // Set mortgage defaults
        document.getElementById('interestRate').value = DEFAULT_VALUES.mortgage.interestRate;
        document.getElementById('loanTerm').value = DEFAULT_VALUES.mortgage.loanTerm;
        document.getElementById('depositPercent').value = DEFAULT_VALUES.mortgage.depositPercent;
        document.getElementById('depositAmount').value = DEFAULT_VALUES.mortgage.depositAmount;

        // Set owner cost defaults
        document.getElementById('strata').value = DEFAULT_VALUES.ownerCosts.strata;
        document.getElementById('council').value = DEFAULT_VALUES.ownerCosts.council;
        document.getElementById('water').value = DEFAULT_VALUES.ownerCosts.water;
        document.getElementById('maintenance').value = DEFAULT_VALUES.ownerCosts.maintenance;

        // Update default text to show calculated values
        this._updateDefaultText();
    }

    _updateDefaultText() {
        // Update household income default text
        const householdIncome = DEFAULT_VALUES.householdIncome;
        const adjustedNetIncome = this._adjustForInflation(
            householdIncome.base, 
            householdIncome.baseYear, 
            householdIncome.targetYear, 
            INFLATION_RATES
        );
        const estimatedGross = this._convertNetToGross(adjustedNetIncome);
        const householdIncomeSpan = document.querySelector('#annualIncome').nextElementSibling;
        householdIncomeSpan.textContent = `Default net: $${Math.round(adjustedNetIncome).toLocaleString()} (ABS equivalised disposable income ${householdIncome.baseYear}-${householdIncome.baseYear + 1}, inflation-adjusted). Estimated gross: $${Math.round(estimatedGross).toLocaleString()}.`;

        // Update cost of living default text
        Object.entries(DEFAULT_VALUES.costOfLiving).forEach(([field, data]) => {
            const adjusted = this._adjustForInflation(
                data.base, 
                data.baseYear, 
                data.targetYear, 
                INFLATION_RATES
            );
            const span = document.querySelector(`#${field}`).nextElementSibling;
            span.textContent = `Default: $${adjusted} (${data.description} ${data.baseYear}-${data.baseYear + 1}, adjusted for inflation)`;
        });
    }

    _updateNetIncome() {
        const householdNetIncome = parseFloat(document.getElementById('annualIncome').value) || 0;
        const weeklyNetIncome = householdNetIncome / 52;
        const householdGrossIncome = this._convertNetToGross(householdNetIncome);
        const weeklyGrossIncome = householdGrossIncome / 52;
        const maxWeeklyHousing = weeklyGrossIncome * 0.30;
        
        // Update all income breakdown fields
        document.getElementById('netIncome').textContent = `$${Math.round(weeklyNetIncome).toLocaleString()}`;
        document.getElementById('annualGrossIncome').textContent = `$${Math.round(householdGrossIncome).toLocaleString()}`;
        document.getElementById('weeklyGrossIncome').textContent = `$${Math.round(weeklyGrossIncome).toLocaleString()}`;
        document.getElementById('maxHousingExpense').textContent = `$${Math.round(maxWeeklyHousing).toLocaleString()}`;
        
        // Update the helper text with the default information
        const helperSpan = document.querySelector('#annualIncome').nextElementSibling;
        if (helperSpan) {
            const householdIncome = DEFAULT_VALUES.householdIncome;
            const adjustedNetIncome = this._adjustForInflation(
                householdIncome.base, 
                householdIncome.baseYear, 
                householdIncome.targetYear, 
                INFLATION_RATES
            );
            helperSpan.textContent = `Default net: $${Math.round(adjustedNetIncome).toLocaleString()} (ABS equivalised disposable income ${householdIncome.baseYear}-${householdIncome.baseYear + 1}, inflation-adjusted).`;
        }
        
        this.updateMapAndTable();
    }

    _calculateMortgage(loanAmount, annualRate, termYears, type) {
        if (loanAmount <= 0) {
            return { payment: 0, interest: 0 };
        }
        const numPayments = termYears * 12;
        if (annualRate === 0) {
            return { payment: loanAmount / numPayments, interest: 0 };
        }

        const monthlyRate = (annualRate / 100) / 12;
        const monthlyInterest = loanAmount * monthlyRate;

        if (type === 'IO') {
            return { payment: monthlyInterest, interest: monthlyInterest };
        }

        const factor = Math.pow(1 + monthlyRate, numPayments);
        const principalAndInterestPayment = monthlyInterest * factor / (factor - 1);
        return { payment: principalAndInterestPayment, interest: monthlyInterest };
    }

    // Convert net income to gross income using Australian tax brackets
    _convertNetToGross(netIncome) {
        if (!Number.isFinite(netIncome)) throw new TypeError("netIncome must be a finite number");
        if (netIncome < 0) return 0; // clamp negatives to zero gross
    
        // 2024–25 tax brackets: 0%, 16%, 30%, 37%, 45%
        const BRACKETS = [
            { lower: 0,      upper: 18_200,  r: 0.00, Cprev:     0 },
            { lower: 18_200, upper: 45_000,  r: 0.16, Cprev:     0 },
            { lower: 45_000, upper: 135_000, r: 0.30, Cprev:  4_288 },
            { lower: 135_000,upper: 190_000, r: 0.37, Cprev: 31_288 },
            { lower: 190_000,upper: Infinity,r: 0.45, Cprev: 51_638 }
        ];
    
        if (netIncome <= BRACKETS[0].upper) return netIncome;
        for (let i = 1; i < BRACKETS.length; i++) {
            const { lower, upper, r, Cprev } = BRACKETS[i];
            const denom = 1 - r;
            if (denom <= 0) continue;
        
            const candidateGross = (netIncome + Cprev - r * lower) / denom;
        
            const inRange =
                candidateGross >= lower &&
                (i === BRACKETS.length - 1 ? candidateGross >= lower : candidateGross < upper);
        
            if (inRange) return candidateGross;
        }
    
        const { lower, r, Cprev } = BRACKETS[BRACKETS.length - 1];
        return (netIncome + Cprev - r * lower) / (1 - r);
    }

    // Convert gross income to net income using Australian tax brackets
    _calculateNetIncome(grossIncome) {
        if (!Number.isFinite(grossIncome)) throw new TypeError("grossIncome must be a finite number");
        if (grossIncome < 0) return 0;
        const BRACKETS = [
            { lower: 0,      upper: 18_200,  r: 0.00 },
            { lower: 18_200, upper: 45_000,  r: 0.16 },
            { lower: 45_000, upper: 135_000, r: 0.30 },
            { lower: 135_000,upper: 190_000, r: 0.37 },
            { lower: 190_000,upper: Infinity,r: 0.45 }
        ];
        let tax = 0;
        for (let i = 0; i < BRACKETS.length; i++) {
            const { lower, upper, r } = BRACKETS[i];
            if (grossIncome > lower) {
                const taxable = Math.min(grossIncome, upper) - lower;
                tax += taxable * r;
            }
        }
        return grossIncome - tax;
    }

    _getUserSettings() {
        const householdNetIncome = parseFloat(document.getElementById('annualIncome').value) || 0;
        const householdGrossIncome = this._convertNetToGross(householdNetIncome);
        const weeklyNetIncome = householdNetIncome / 52;
        const weeklyGrossIncome = householdGrossIncome / 52;

        const utilities = parseFloat(document.getElementById('utilities').value) || 0;
        const food = parseFloat(document.getElementById('food').value) || 0;
        const transport = parseFloat(document.getElementById('transport').value) || 0;
        const other = parseFloat(document.getElementById('other').value) || 0;

        const weeklyLivingCosts = utilities + food + transport + other;

            const strata = parseFloat(document.getElementById('strata').value) || 0;
            const council = parseFloat(document.getElementById('council').value) || 0;
            const water = parseFloat(document.getElementById('water').value) || 0;
            const maintenance = parseFloat(document.getElementById('maintenance').value) || 0;
        const weeklyOwnerCosts = strata + council + water + maintenance;

        return {
            grossIncome: householdGrossIncome,
            netIncome: householdNetIncome,
            weeklyNetIncome,
            weeklyGrossIncome,
            weeklyLivingCosts,
            weeklyOwnerCosts
        };
    }

    _updateAllAffordability() {
        const userSettings = this._getUserSettings();
        const { weeklyGrossIncome } = userSettings;
        const pricePoint = document.getElementById('pricePoint').value;

        for (const postcode in this.housingData) {
            const data = this.housingData[postcode];
            
            let salesPrice, rent;
            if (pricePoint === 'q1') {
                salesPrice = (data.yearly_first_quartile_sales_000s || 0) * 1000;
                rent = data.yearly_first_quartile_weekly_rent;
            } else if (pricePoint === 'q3') {
                salesPrice = (data.yearly_third_quartile_sales_000s || 0) * 1000;
                rent = data.yearly_third_quartile_weekly_rent;
            } else { // median
                salesPrice = (data.yearly_median_sales_price_000s || 0) * 1000;
                rent = data.yearly_median_weekly_rent;
            }

            let weeklyHousingCost = 0;
            let affordabilityPercentage = 0;

            if (this.housingType === 'rent' && rent && rent > 0) {
                weeklyHousingCost = rent;
                affordabilityPercentage = (weeklyHousingCost / weeklyGrossIncome) * 100;
            } else if (this.housingType === 'buy' && salesPrice && salesPrice > 0) {
                const depositPercent = parseFloat(document.getElementById('depositPercent').value) || 20;
                const depositAmount = parseFloat(document.getElementById('depositAmount').value) || 0;
                const interestRate = parseFloat(document.getElementById('interestRate').value) || 6.5;
                const loanTermYears = parseFloat(document.getElementById('loanTerm').value) || 30;

                const actualDeposit = this.depositType === 'percent'
                    ? salesPrice * (depositPercent / 100)
                    : depositAmount;

                const loanAmount = Math.max(0, salesPrice - actualDeposit);
                const mortgage = this._calculateMortgage(loanAmount, interestRate, loanTermYears, this.mortgageType);

                const weeklyMortgagePayment = mortgage.payment * 12 / 52;
                weeklyHousingCost = weeklyMortgagePayment + userSettings.weeklyOwnerCosts;
                affordabilityPercentage = (weeklyHousingCost / weeklyGrossIncome) * 100;

                data.calculated_weekly_payment = weeklyMortgagePayment;
                data.calculated_weekly_interest = mortgage.interest * 12 / 52;
            }

            data.weekly_housing_cost = weeklyHousingCost;
            data.affordability_percentage = affordabilityPercentage;
            data.is_affordable = affordabilityPercentage <= 30;
            const weeklyAfterExpenses = userSettings.weeklyNetIncome - userSettings.weeklyLivingCosts;
            data.weekly_money_leftover = (weeklyHousingCost > 0)
                ? (weeklyAfterExpenses - weeklyHousingCost)
                : null;

            this._calculateQuartilePayments(data, userSettings);
        }
    }

    _calculateQuartilePayments(data, userSettings) {
        data.yearly_first_quartile_weekly_rent_payment = data.yearly_first_quartile_weekly_rent;
        data.yearly_third_quartile_weekly_rent_payment = data.yearly_third_quartile_weekly_rent;
        
        const q1Sales = (data.yearly_first_quartile_sales_000s || 0) * 1000;
        const q3Sales = (data.yearly_third_quartile_sales_000s || 0) * 1000;

        if (q1Sales > 0) {
            const depositPercent = parseFloat(document.getElementById('depositPercent').value) || 20;
            const depositAmount = parseFloat(document.getElementById('depositAmount').value) || 0;
            const interestRate = parseFloat(document.getElementById('interestRate').value) || 6.5;
            const loanTermYears = parseFloat(document.getElementById('loanTerm').value) || 30;

            const actualDeposit = this.depositType === 'percent'
                ? q1Sales * (depositPercent / 100)
                : depositAmount;

            const q1Loan = Math.max(0, q1Sales - actualDeposit);
            const q1Mortgage = this._calculateMortgage(q1Loan, interestRate, loanTermYears, this.mortgageType);
            data.yearly_first_quartile_weekly_payment = q1Mortgage.payment * 12 / 52 + userSettings.weeklyOwnerCosts;
        } else {
            data.yearly_first_quartile_weekly_payment = null;
        }

        if (q3Sales > 0) {
            const depositPercent = parseFloat(document.getElementById('depositPercent').value) || 20;
            const depositAmount = parseFloat(document.getElementById('depositAmount').value) || 0;
            const interestRate = parseFloat(document.getElementById('interestRate').value) || 6.5;
            const loanTermYears = parseFloat(document.getElementById('loanTerm').value) || 30;

            const actualDeposit = this.depositType === 'percent'
                ? q3Sales * (depositPercent / 100)
                : depositAmount;

            const q3Loan = Math.max(0, q3Sales - actualDeposit);
            const q3Mortgage = this._calculateMortgage(q3Loan, interestRate, loanTermYears, this.mortgageType);
            data.yearly_third_quartile_weekly_payment = q3Mortgage.payment * 12 / 52 + userSettings.weeklyOwnerCosts;
        } else {
            data.yearly_third_quartile_weekly_payment = null;
        }
    }

    _renderMap() {
        if (this.geojsonLayer) {
            this.map.removeLayer(this.geojsonLayer);
        }
        this.geojsonLayer = L.geoJson(this.geojsonData, {
            style: (feature) => this._styleFeature(feature),
            onEachFeature: (feature, layer) => this._onEachFeature(feature, layer)
        }).addTo(this.map);
    }

    updateMapAndTable() {
        this._updateAllAffordability();

            this._renderMap();

        if (this.openPostcode) {
            this._refreshOpenPopup();
        }
    }

    _getColor(percentage, weeklyMoneyLeftover) {
        if (weeklyMoneyLeftover != null && weeklyMoneyLeftover < 0) return '#000000';
        if (percentage === null || isNaN(percentage) || percentage === 0) return '#ccc';
        if (percentage <= 20) return '#16a34a'; // Dark green - well below 30% rule (very affordable)
        if (percentage <= 30) return '#22c55e'; // Green - at or below 30% rule (affordable)
        if (percentage <= 40) return '#fbbf24'; // Yellow - moderate housing stress
        if (percentage <= 50) return '#f97316'; // Orange - high housing stress
        return '#ef4444'; // Red - severe housing stress (unaffordable)
    }

    _styleFeature(feature) {
        const postcode = String(feature.properties.POA_CODE21);
        const data = this.housingData[postcode];
        const percentage = data ? data.affordability_percentage : null;
        const leftover = data ? data.weekly_money_leftover : null;
        return {
            ...this.defaultStyle,
            fillColor: this._getColor(percentage, leftover)
        };
    }

    _onEachFeature(feature, layer) {
        layer.on({
            mouseover: () => this._highlightFeature(layer),
            mouseout: () => this.geojsonLayer.resetStyle(layer),
            click: (event) => this._showPopup(event, feature, layer)
        });
    }

    _highlightFeature(layer) {
        layer.setStyle(this.highlightStyle);
        layer.bringToFront();
    }



    _showPopup(event, feature, layer, isRefresh = false) {
        const postcode = String(feature.properties.POA_CODE21);
        const data = this.housingData[postcode];
        if (!data) return;

        if (this.activePopupLayer && this.activePopupLayer !== layer) {
            this.activePopupLayer.closePopup();
        }

        if (!isRefresh) {
            this.openPostcode = postcode;
            this.activePopupLayer = layer;
        }

        const popupContent = this._createPopupContent(postcode, data);

        if (this._isMobile()) {
            // Show mobile overlay
            const mobileContent = document.getElementById('mobile-popup-content');
            mobileContent.innerHTML = '';
            mobileContent.appendChild(popupContent.cloneNode(true));
            document.getElementById('mobile-popup-overlay').classList.remove('hidden');
        } else {
            // Show desktop popup
        if (!layer.getPopup()) {
                layer.bindPopup(popupContent, { closeOnClick: false, keepInView: false, autoClose: false, maxWidth: 520 });
        } else {
            layer.getPopup().setContent(popupContent);
        }

        if (!layer.getPopup().isOpen()) {
            layer.openPopup(event.latlng);
            }
        }
    }

    _refreshOpenPopup() {
        if (this.activePopupLayer) {
            this._showPopup({ latlng: this.activePopupLayer.getBounds().getCenter() }, this.activePopupLayer.feature, this.activePopupLayer, true);
        } else if (this.openPostcode && this._isMobile()) {
            // Refresh mobile popup if it's open
            const overlay = document.getElementById('mobile-popup-overlay');
            if (!overlay.classList.contains('hidden')) {
                const data = this.housingData[this.openPostcode];
                if (data) {
                    const popupContent = this._createPopupContent(this.openPostcode, data);
                    const mobileContent = document.getElementById('mobile-popup-content');
                    mobileContent.innerHTML = '';
                    mobileContent.appendChild(popupContent.cloneNode(true));
                }
            }
        }
    }

    _createPopupContent(postcode, data) {
        const formatter = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
        const template = document.getElementById('popup-template').content.cloneNode(true);
        const suburbs = this.suburbLookup[postcode] || `Postcode ${postcode}`;

        let displaySuburbs = suburbs;
        const suburbList = suburbs.split(/\s*,\s*/);
        if (suburbList.length > 9) {
            displaySuburbs = suburbList.slice(0, 9).join(', ') + '...';
        }

        const setContent = (selector, text) => { template.querySelector(selector).textContent = text; };

        // Header
        setContent('#popup-suburbs', displaySuburbs);
        template.querySelector('#popup-suburbs').setAttribute('title', suburbs);
        setContent('#popup-postcode', `Postcode: ${postcode}`);

        const formatCurrency = (val) => (val != null) ? formatter.format(val) : 'N/A';
        const formatWeeklyCurrency = (val) => (val != null) ? formatter.format(Math.round(val)) : 'N/A';

        // Income breakdown
        const userSettings = this._getUserSettings();
        const weeklyNetIncome = userSettings.weeklyNetIncome;
        const weeklyGrossIncome = userSettings.weeklyGrossIncome;
        const weeklyAfterExpenses = weeklyNetIncome - userSettings.weeklyLivingCosts;

        // Populate income breakdown
        setContent('#net-income-weekly', formatWeeklyCurrency(weeklyNetIncome));
        setContent('#gross-income-weekly', formatWeeklyCurrency(weeklyGrossIncome));
        setContent('#after-expenses-weekly', formatCurrency(weeklyAfterExpenses));

        // Rent option - get the appropriate price point
        const pricePoint = document.getElementById('pricePoint').value;
        let rentCost;
        if (pricePoint === 'q1') {
            rentCost = data.yearly_first_quartile_weekly_rent;
        } else if (pricePoint === 'q3') {
            rentCost = data.yearly_third_quartile_weekly_rent;
        } else { // median
            rentCost = data.yearly_median_weekly_rent;
        }
        
        if (rentCost != null && rentCost > 0) {
        const moneyAfterRent = weeklyAfterExpenses - rentCost;
        setContent('#rent-cost-weekly', formatWeeklyCurrency(rentCost));
            const moneyAfterRentElement = template.querySelector('#money-after-rent');
            // Color negative values black (strip any prior Tailwind text- classes and force black)
            console.log('Money after rent:', moneyAfterRent, 'Is negative:', moneyAfterRent < 0);
            moneyAfterRentElement.textContent = formatCurrency(moneyAfterRent);
            // remove any text-* classes
            moneyAfterRentElement.className = (moneyAfterRentElement.className || '')
                .split(/\s+/)
                .filter(c => !/^text-/.test(c))
                .concat(['font-semibold','text-sm'])
                .join(' ');
            if (moneyAfterRent < 0) {
                moneyAfterRentElement.style.setProperty('color', 'black', 'important');
                moneyAfterRentElement.style.fontWeight = 'bold';
            } else {
                moneyAfterRentElement.style.removeProperty('color');
                moneyAfterRentElement.style.fontWeight = '';
            }
        } else {
            setContent('#rent-cost-weekly', 'N/A');
            setContent('#money-after-rent', 'N/A');
        }

        // Buy option - always calculate mortgage for popup display (regardless of housing type)
        let mortgageCost = 0;
        const ownerCosts = userSettings.weeklyOwnerCosts;
        
        // Get sales price for the selected price point
        let salesPrice;
        if (pricePoint === 'q1') {
            salesPrice = (data.yearly_first_quartile_sales_000s || 0) * 1000;
        } else if (pricePoint === 'q3') {
            salesPrice = (data.yearly_third_quartile_sales_000s || 0) * 1000;
        } else { // median
            salesPrice = (data.yearly_median_sales_price_000s || 0) * 1000;
        }
        
        // Always calculate mortgage if we have sales data (for popup display)
        if (salesPrice && salesPrice > 0) {
            const depositPercent = parseFloat(document.getElementById('depositPercent').value) || 20;
            const depositAmount = parseFloat(document.getElementById('depositAmount').value) || 0;
            const interestRate = parseFloat(document.getElementById('interestRate').value) || 6.5;
            const loanTermYears = parseFloat(document.getElementById('loanTerm').value) || 30;

            const actualDeposit = this.depositType === 'percent'
                ? salesPrice * (depositPercent / 100)
                : depositAmount;

            const loanAmount = Math.max(0, salesPrice - actualDeposit);
            const mortgage = this._calculateMortgage(loanAmount, interestRate, loanTermYears, this.mortgageType);
            mortgageCost = mortgage.payment * 12 / 52;
        }
        
        const hasMortgageData = mortgageCost > 0;
        
        if (hasMortgageData) {
            const totalBuyCost = mortgageCost + ownerCosts;
            const moneyAfterBuy = weeklyAfterExpenses - totalBuyCost;
            
            setContent('#mortgage-cost-weekly', formatCurrency(mortgageCost));
            setContent('#owner-costs-weekly', formatCurrency(ownerCosts));
            setContent('#total-buy-cost-weekly', formatCurrency(totalBuyCost));
            
            const moneyAfterBuyElement = template.querySelector('#money-after-buy');
            // Color negative values black (strip any prior Tailwind text- classes and force black)
            console.log('Money after buy:', moneyAfterBuy, 'Is negative:', moneyAfterBuy < 0);
            moneyAfterBuyElement.textContent = formatCurrency(moneyAfterBuy);
            // remove any text-* classes
            moneyAfterBuyElement.className = (moneyAfterBuyElement.className || '')
                .split(/\s+/)
                .filter(c => !/^text-/.test(c))
                .concat(['font-semibold','text-sm'])
                .join(' ');
            if (moneyAfterBuy < 0) {
                moneyAfterBuyElement.style.setProperty('color', 'black', 'important');
                moneyAfterBuyElement.style.fontWeight = 'bold';
            } else {
                moneyAfterBuyElement.style.removeProperty('color');
                moneyAfterBuyElement.style.fontWeight = '';
            }
        } else {
            setContent('#mortgage-cost-weekly', 'N/A');
            setContent('#owner-costs-weekly', 'N/A');
            setContent('#total-buy-cost-weekly', 'N/A');
            setContent('#money-after-buy', 'N/A');
        }

        // Price point label - more relatable phrasing (property instead of house)
        const pricePointLabel = pricePoint === 'q1' ? 'Below-average property (25th percentile)' : 
                               pricePoint === 'q3' ? 'Above-average property (75th percentile)' : 
                               'Average property (50th percentile)';
        setContent('#price-point-label', pricePointLabel);

        // Sale price label reflecting selected percentile
        const salePriceLabel = pricePoint === 'q1' ? '25th percentile' : pricePoint === 'q3' ? '75th percentile' : '50th percentile';
        setContent('#sale-price-label', salePriceLabel);

        // Display sale price for the selected price point (not always median)
        let selectedSalesPrice;
        if (pricePoint === 'q1') {
            selectedSalesPrice = (data.yearly_first_quartile_sales_000s || 0) * 1000;
        } else if (pricePoint === 'q3') {
            selectedSalesPrice = (data.yearly_third_quartile_sales_000s || 0) * 1000;
        } else {
            selectedSalesPrice = (data.yearly_median_sales_price_000s || 0) * 1000;
        }
        // Format sale price - show as millions if over 1000k
        let formattedSalePrice = 'N/A';
        if (selectedSalesPrice > 0) {
            if (selectedSalesPrice >= 1000000) {
                formattedSalePrice = (selectedSalesPrice / 1000000).toFixed(1).replace('.0', '') + 'M';
            } else {
                formattedSalePrice = (selectedSalesPrice / 1000).toLocaleString() + 'k';
            }
        }
        setContent('#median-sale-price-000s', formattedSalePrice);

        const popupContainer = document.createElement('div');
        popupContainer.appendChild(template);
        return popupContainer;
    }


    _addLegend() {
        const legend = L.control({ position: 'bottomright' });
        legend.onAdd = () => {
            const div = L.DomUtil.create('div', 'info legend p-2 bg-white rounded-lg shadow-lg border border-gray-200');
            const grades = [
                { limit: 20, color: this._getColor(15), label: '≤ 20% (Well Below 30% Rule)' },
                { limit: 30, color: this._getColor(25), label: '21-30% (At 30% Rule Limit)' },
                { limit: 40, color: this._getColor(35), label: '31-40% (Moderate Housing Stress)' },
                { limit: 50, color: this._getColor(45), label: '41-50% (High Housing Stress)' },
                { limit: Infinity, color: this._getColor(55), label: '> 50% (Severe Housing Stress)' }
            ];

            let content = `
                <div class="flex items-center justify-between cursor-pointer mb-2" id="legend-toggle">
                    <h4 class="font-bold text-sm">Housing Affordability</h4>
                    <svg id="legend-chevron" class="w-4 h-4 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                    </svg>
                </div>
                <div id="legend-content" class="space-y-1">
            `;
            grades.forEach(g => {
                content += `<p><i style="background:${g.color}"></i> ${g.label}</p>`;
            });
            // Place Negative leftover at the end (worst case)
            content += `<p><i style="background:#000; border: 1px solid #777; margin-left: 0;"></i> Negative leftover</p>`;
            content += '<hr class="my-1 border-gray-300"><p class="text-xs">No Data: <i style="background:#ccc; border: 1px solid #777; margin-left: 0;"></i></p>';
            content += '</div>';
            div.innerHTML = content;
            
            // Add click handler for toggle
            const toggle = div.querySelector('#legend-toggle');
            const contentDiv = div.querySelector('#legend-content');
            const chevron = div.querySelector('#legend-chevron');
            
            toggle.addEventListener('click', () => {
                contentDiv.classList.toggle('hidden');
                chevron.classList.toggle('rotate-180');
            });
            
            return div;
        };
        legend.addTo(this.map);
    }

    _handleHousingTypeChange(type) {
        this.housingType = type;
        const mortgageSettings = document.getElementById('mortgageSettings');
        const ownerCosts = document.getElementById('ownerCosts');
        
        if (type === 'buy') {
            mortgageSettings.classList.remove('hidden');
            ownerCosts.classList.remove('hidden');
        } else {
            mortgageSettings.classList.add('hidden');
            ownerCosts.classList.add('hidden');
        }
        
        this.updateMapAndTable();
    }

    _handleMortgageTypeChange(type) {
        this.mortgageType = type;
        this._toggleLoanTermVisibility();
        this.updateMapAndTable();
    }

    _handleDepositTypeChange(type) {
        this.depositType = type;
        const isPercent = type === 'percent';
        document.getElementById('depositPercent').style.display = isPercent ? 'block' : 'none';
        document.getElementById('depositAmount').style.display = isPercent ? 'none' : 'block';
        this.updateMapAndTable();
    }

    _toggleLoanTermVisibility() {
        const loanTermGroup = document.getElementById('loanTermGroup');
        loanTermGroup.style.display = (this.mortgageType === 'IO') ? 'none' : 'flex';
    }

    _setupCollapsibleControls() {
        const header = document.getElementById('controls-header');
        header.addEventListener('click', () => {
            document.getElementById('controls-content').classList.toggle('hidden');
            document.getElementById('controls-chevron').classList.toggle('rotate-180');
        });
    }

    _setupMobilePopup() {
        const backButton = document.getElementById('mobile-popup-back');
        const overlay = document.getElementById('mobile-popup-overlay');
        
        backButton.addEventListener('click', () => {
            overlay.classList.add('hidden');
            // Close any open popup on the map
            if (this.activePopupLayer) {
                this.activePopupLayer.closePopup();
                this.activePopupLayer = null;
                this.openPostcode = null;
            }
        });
    }

    _setupWindowResize() {
        window.addEventListener('resize', () => {
            // If switching from mobile to desktop and mobile popup is open, close it
            if (!this._isMobile() && this.openPostcode) {
                const overlay = document.getElementById('mobile-popup-overlay');
                if (!overlay.classList.contains('hidden')) {
                    overlay.classList.add('hidden');
                    // Show desktop popup instead
                    if (this.activePopupLayer) {
                        this._showPopup({ latlng: this.activePopupLayer.getBounds().getCenter() }, this.activePopupLayer.feature, this.activePopupLayer, true);
                    }
                }
            }
        });
    }

    _setupHeaderToggle() {
        const toggleButton = document.getElementById('header-toggle');
        const description = document.getElementById('header-description');
        const chevron = document.getElementById('header-chevron');
        
        if (toggleButton && description && chevron) {
            toggleButton.addEventListener('click', () => {
                description.classList.toggle('hidden');
                chevron.classList.toggle('rotate-180');
            });
        }
    }

    _isMobile() {
        return window.innerWidth < 768; // md breakpoint
    }

}

document.addEventListener('DOMContentLoaded', () => {
    new HousingAffordabilityMap();
});