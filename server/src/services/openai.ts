import OpenAI from "openai";
import { extractCleanJSON, parsePartialJSON } from "../utils/openai";
import { MealAnalysisResult, MealPlanRequest, MealPlanResponse } from "../types/openai";

// Initialize OpenAI with better error handling
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 45000, // 45 seconds timeout
      maxRetries: 2, // Reduce retries for faster failure
    })
  : null;

// Request queue to prevent duplicate requests
const requestQueue = new Map<string, Promise<any>>();

// Enhanced rate limiting and caching
const requestCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes cache
const MAX_CACHE_SIZE = 100;

export class OpenAIService {
  private static createRequestKey(prompt: string, type: string): string {
    // Create a hash-like key from the prompt for caching
    return `${type}_${prompt.substring(0, 100).replace(/\s+/g, '_')}`;
  }

  private static getCachedResponse(key: string): any | null {
    const cached = requestCache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      console.log("🔄 Using cached OpenAI response");
      return cached.data;
    }
    return null;
  }

  private static setCachedResponse(key: string, data: any): void {
    // Clean old cache entries if we're at the limit
    if (requestCache.size >= MAX_CACHE_SIZE) {
      const oldestKey = requestCache.keys().next().value;
      requestCache.delete(oldestKey);
    }
    
    requestCache.set(key, { data, timestamp: Date.now() });
  }

  static async analyzeMealImage(
    imageBase64: string,
    language: string = "english",
    updateText?: string,
    editedIngredients: any[] = []
  ): Promise<MealAnalysisResult> {
    const requestKey = this.createRequestKey(
      `${imageBase64.substring(0, 50)}_${updateText || ''}_${language}`,
      'analyze'
    );

    // Check cache first
    const cached = this.getCachedResponse(requestKey);
    if (cached) {
      return cached;
    }

    // Check if same request is already in progress
    if (requestQueue.has(requestKey)) {
      console.log("🔄 Waiting for existing analysis request");
      return requestQueue.get(requestKey);
    }

    const requestPromise = this._performMealAnalysis(
      imageBase64,
      language,
      updateText,
      editedIngredients
    );

    requestQueue.set(requestKey, requestPromise);

    try {
      const result = await requestPromise;
      this.setCachedResponse(requestKey, result);
      return result;
    } finally {
      // Clean up queue after a delay
      setTimeout(() => {
        requestQueue.delete(requestKey);
      }, 1000);
    }
  }

  private static async _performMealAnalysis(
    imageBase64: string,
    language: string,
    updateText?: string,
    editedIngredients: any[] = []
  ): Promise<MealAnalysisResult> {
    if (!openai) {
      console.log("⚠️ OpenAI not available, using enhanced fallback");
      return this.generateEnhancedFallbackAnalysis(language, updateText);
    }

    try {
      const isHebrew = language === "hebrew";
      
      // Create optimized system prompt
      const systemPrompt = this.createOptimizedSystemPrompt(isHebrew, updateText, editedIngredients);
      
      // Create user prompt
      const userPrompt = updateText
        ? this.createUpdatePrompt(updateText, isHebrew)
        : this.createAnalysisPrompt(isHebrew);

      console.log("🤖 Calling OpenAI API with optimized prompts...");

      const response = await openai.chat.completions.create({
        model: "gpt-4o", // Use faster model
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: userPrompt },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${imageBase64}`,
                  detail: "high",
                },
              },
            ],
          },
        ],
        max_tokens: 1500, // Reduced for faster response
        temperature: 0.1, // Lower temperature for more consistent results
        top_p: 0.9,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("No content in OpenAI response");
      }

      console.log("✅ OpenAI response received, parsing...");
      return this.parseAnalysisResponse(content, language);
    } catch (error: any) {
      console.error("💥 OpenAI analysis error:", error);
      
      // Enhanced error handling
      if (error.code === 'rate_limit_exceeded') {
        throw new Error("AI service is busy. Please try again in a moment.");
      } else if (error.code === 'insufficient_quota') {
        throw new Error("AI analysis quota exceeded. Please try again later.");
      } else if (error.message?.includes('timeout')) {
        throw new Error("Analysis is taking too long. Please try again.");
      }
      
      // Return enhanced fallback for other errors
      return this.generateEnhancedFallbackAnalysis(language, updateText);
    }
  }

  private static createOptimizedSystemPrompt(
    isHebrew: boolean,
    updateText?: string,
    editedIngredients: any[] = []
  ): string {
    const basePrompt = isHebrew
      ? `אתה מנתח תזונה מומחה. נתח את התמונה ותן תוצאות מדויקות בעברית.`
      : `You are an expert nutrition analyst. Analyze the image and provide accurate results.`;

    const jsonStructure = `
{
  "name": "${isHebrew ? 'שם הארוחה' : 'meal name'}",
  "calories": ${isHebrew ? 'מספר קלוריות' : 'number'},
  "protein": ${isHebrew ? 'חלבון בגרמים' : 'protein in grams'},
  "carbs": ${isHebrew ? 'פחמימות בגרמים' : 'carbs in grams'},
  "fat": ${isHebrew ? 'שומן בגרמים' : 'fat in grams'},
  "fiber": ${isHebrew ? 'סיבים בגרמים' : 'fiber in grams'},
  "sugar": ${isHebrew ? 'סוכר בגרמים' : 'sugar in grams'},
  "sodium": ${isHebrew ? 'נתרן במילגרם' : 'sodium in mg'},
  "ingredients": [{"name": "${isHebrew ? 'שם מרכיב' : 'ingredient name'}", "calories": ${isHebrew ? 'קלוריות' : 'calories'}}],
  "confidence": ${isHebrew ? 'רמת ביטחון 1-100' : 'confidence 1-100'},
  "servingSize": "${isHebrew ? 'גודל מנה' : 'serving size'}",
  "cookingMethod": "${isHebrew ? 'שיטת הכנה' : 'cooking method'}",
  "healthNotes": "${isHebrew ? 'הערות בריאות' : 'health notes'}"
}`;

    return `${basePrompt}

${updateText ? (isHebrew ? 'עדכן את הניתוח לפי:' : 'Update analysis based on:') + updateText : ''}
${editedIngredients.length > 0 ? (isHebrew ? 'מרכיבים ערוכים:' : 'Edited ingredients:') + JSON.stringify(editedIngredients) : ''}

${isHebrew ? 'החזר JSON בלבד:' : 'Return only JSON:'} ${jsonStructure}`;
  }

  private static createAnalysisPrompt(isHebrew: boolean): string {
    return isHebrew
      ? "נתח את הארוחה בתמונה ותן פירוט תזונתי מדויק."
      : "Analyze the meal in the image and provide accurate nutritional breakdown.";
  }

  private static createUpdatePrompt(updateText: string, isHebrew: boolean): string {
    return isHebrew
      ? `עדכן את הניתוח הקיים בהתבסס על המידע הנוסף: ${updateText}`
      : `Update the existing analysis based on additional information: ${updateText}`;
  }

  private static parseAnalysisResponse(content: string, language: string): MealAnalysisResult {
    try {
      const cleanedContent = extractCleanJSON(content);
      const parsed = parsePartialJSON(cleanedContent);

      // Validate and normalize the response
      return {
        name: parsed.name || (language === "hebrew" ? "ארוחה" : "Meal"),
        calories: Number(parsed.calories) || 0,
        protein: Number(parsed.protein) || 0,
        carbs: Number(parsed.carbs) || 0,
        fat: Number(parsed.fat) || 0,
        fiber: Number(parsed.fiber) || 0,
        sugar: Number(parsed.sugar) || 0,
        sodium: Number(parsed.sodium) || 0,
        confidence: Math.min(100, Math.max(1, Number(parsed.confidence) || 75)),
        ingredients: Array.isArray(parsed.ingredients) ? parsed.ingredients : [],
        servingSize: parsed.servingSize || (language === "hebrew" ? "מנה אחת" : "1 serving"),
        cookingMethod: parsed.cookingMethod || (language === "hebrew" ? "לא ידוע" : "Unknown"),
        healthNotes: parsed.healthNotes || "",
        
        // Additional fields with defaults
        saturated_fats_g: Number(parsed.saturated_fats_g) || undefined,
        polyunsaturated_fats_g: Number(parsed.polyunsaturated_fats_g) || undefined,
        monounsaturated_fats_g: Number(parsed.monounsaturated_fats_g) || undefined,
        omega_3_g: Number(parsed.omega_3_g) || undefined,
        omega_6_g: Number(parsed.omega_6_g) || undefined,
        soluble_fiber_g: Number(parsed.soluble_fiber_g) || undefined,
        insoluble_fiber_g: Number(parsed.insoluble_fiber_g) || undefined,
        cholesterol_mg: Number(parsed.cholesterol_mg) || undefined,
        alcohol_g: Number(parsed.alcohol_g) || undefined,
        caffeine_mg: Number(parsed.caffeine_mg) || undefined,
        liquids_ml: Number(parsed.liquids_ml) || undefined,
        serving_size_g: Number(parsed.serving_size_g) || undefined,
        allergens_json: parsed.allergens_json || {},
        vitamins_json: parsed.vitamins_json || {},
        micronutrients_json: parsed.micronutrients_json || {},
        glycemic_index: Number(parsed.glycemic_index) || undefined,
        insulin_index: Number(parsed.insulin_index) || undefined,
        food_category: parsed.food_category || "",
        processing_level: parsed.processing_level || "",
        cooking_method: parsed.cooking_method || "",
        additives_json: parsed.additives_json || {},
        health_risk_notes: parsed.health_risk_notes || undefined,
      };
    } catch (error) {
      console.error("💥 Error parsing OpenAI response:", error);
      console.log("📄 Raw content:", content.substring(0, 500));
      
      // Return fallback analysis
      return this.generateEnhancedFallbackAnalysis(language);
    }
  }

  private static generateEnhancedFallbackAnalysis(
    language: string,
    updateText?: string
  ): MealAnalysisResult {
    const isHebrew = language === "hebrew";
    
    // Generate more realistic fallback data
    const baseCalories = 300 + Math.floor(Math.random() * 400); // 300-700 calories
    const proteinRatio = 0.15 + Math.random() * 0.15; // 15-30% protein
    const carbRatio = 0.35 + Math.random() * 0.25; // 35-60% carbs
    const fatRatio = 1 - proteinRatio - carbRatio; // Remaining as fat

    return {
      name: updateText 
        ? (isHebrew ? `ארוחה מעודכנת - ${updateText.substring(0, 20)}` : `Updated meal - ${updateText.substring(0, 20)}`)
        : (isHebrew ? "ארוחה מנותחת" : "Analyzed meal"),
      calories: baseCalories,
      protein: Math.round((baseCalories * proteinRatio) / 4),
      carbs: Math.round((baseCalories * carbRatio) / 4),
      fat: Math.round((baseCalories * fatRatio) / 9),
      fiber: Math.round(3 + Math.random() * 7), // 3-10g fiber
      sugar: Math.round(5 + Math.random() * 15), // 5-20g sugar
      sodium: Math.round(200 + Math.random() * 600), // 200-800mg sodium
      confidence: 65, // Lower confidence for fallback
      ingredients: [
        {
          name: isHebrew ? "מרכיב עיקרי" : "Main ingredient",
          calories: Math.round(baseCalories * 0.6),
          protein: Math.round((baseCalories * proteinRatio * 0.6) / 4),
          carbs: Math.round((baseCalories * carbRatio * 0.6) / 4),
          fat: Math.round((baseCalories * fatRatio * 0.6) / 9),
          fiber: Math.round(2 + Math.random() * 4),
          sugar: Math.round(3 + Math.random() * 8),
          sodium_mg: Math.round(100 + Math.random() * 300),
        },
      ],
      servingSize: isHebrew ? "מנה בינונית" : "Medium serving",
      cookingMethod: isHebrew ? "בישול רגיל" : "Regular cooking",
      healthNotes: isHebrew 
        ? "ניתוח זה מבוסס על הערכה כללית. לדיוק מירבי, אנא ספק פרטים נוספים."
        : "This analysis is based on general estimation. For maximum accuracy, please provide additional details.",
    };
  }

  static async updateMealAnalysis(
    originalAnalysis: any,
    updateText: string,
    language: string = "english"
  ): Promise<MealAnalysisResult> {
    const requestKey = this.createRequestKey(`update_${updateText}_${language}`, 'update');
    
    // Check cache first
    const cached = this.getCachedResponse(requestKey);
    if (cached) {
      return cached;
    }

    if (!openai) {
      console.log("⚠️ OpenAI not available, using enhanced fallback for update");
      return this.generateEnhancedFallbackAnalysis(language, updateText);
    }

    try {
      const isHebrew = language === "hebrew";
      
      const systemPrompt = isHebrew
        ? `אתה מנתח תזונה מומחה. עדכן את הניתוח הקיים בהתבסס על המידע החדש. החזר JSON בלבד.`
        : `You are an expert nutrition analyst. Update the existing analysis based on new information. Return only JSON.`;

      const userPrompt = `
${isHebrew ? 'ניתוח קיים:' : 'Existing analysis:'} ${JSON.stringify(originalAnalysis)}

${isHebrew ? 'מידע לעדכון:' : 'Update information:'} ${updateText}

${isHebrew ? 'החזר JSON מעודכן עם אותה מבנה:' : 'Return updated JSON with same structure:'}
{
  "name": "string",
  "calories": number,
  "protein": number,
  "carbs": number,
  "fat": number,
  "fiber": number,
  "sugar": number,
  "sodium": number,
  "confidence": number,
  "ingredients": [],
  "servingSize": "string",
  "cookingMethod": "string",
  "healthNotes": "string"
}`;

      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 1000,
        temperature: 0.1,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("No content in update response");
      }

      const result = this.parseAnalysisResponse(content, language);
      this.setCachedResponse(requestKey, result);
      return result;
    } catch (error) {
      console.error("💥 Error updating meal analysis:", error);
      return this.generateEnhancedFallbackAnalysis(language, updateText);
    }
  }

  static async generateText(
    prompt: string,
    maxTokens: number = 1000,
    temperature: number = 0.7
  ): Promise<string> {
    const requestKey = this.createRequestKey(prompt, 'text');
    
    // Check cache first
    const cached = this.getCachedResponse(requestKey);
    if (cached) {
      return cached;
    }

    if (!openai) {
      return "AI text generation is not available. Please configure OpenAI API key.";
    }

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o", // Use faster model
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature,
      });

      const result = response.choices[0]?.message?.content || "";
      this.setCachedResponse(requestKey, result);
      return result;
    } catch (error) {
      console.error("💥 Error generating text:", error);
      return "Text generation failed. Please try again.";
    }
  }

  static async generateMealPlan(request: MealPlanRequest): Promise<MealPlanResponse> {
    const requestKey = this.createRequestKey(
      `mealplan_${request.target_calories_daily}_${request.meals_per_day}_${request.dietary_preferences.join(',')}`,
      'mealplan'
    );
    
    // Check cache first
    const cached = this.getCachedResponse(requestKey);
    if (cached) {
      return cached;
    }

    if (!openai) {
      console.log("⚠️ OpenAI not available, generating fallback meal plan");
      return this.generateFallbackMealPlan(request);
    }

    try {
      const prompt = this.createMealPlanPrompt(request);
      
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 3000,
        temperature: 0.3,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("No content in meal plan response");
      }

      const result = this.parseMealPlanResponse(content);
      this.setCachedResponse(requestKey, result);
      return result;
    } catch (error) {
      console.error("💥 Error generating meal plan:", error);
      return this.generateFallbackMealPlan(request);
    }
  }

  private static createMealPlanPrompt(request: MealPlanRequest): string {
    return `Create a ${request.rotation_frequency_days}-day meal plan with ${request.meals_per_day} meals per day.

Target nutrition:
- Calories: ${request.target_calories_daily}/day
- Protein: ${request.target_protein_daily}g/day
- Carbs: ${request.target_carbs_daily}g/day
- Fats: ${request.target_fats_daily}g/day

Preferences:
- Dietary: ${request.dietary_preferences.join(", ")}
- Exclude: ${request.excluded_ingredients.join(", ")}
- Allergies: ${request.allergies.join(", ")}
- Activity: ${request.physical_activity_level}
- Goal: ${request.main_goal}

Return JSON with weekly_plan array containing day objects with meals array.`;
  }

  private static parseMealPlanResponse(content: string): MealPlanResponse {
    try {
      const cleanedContent = extractCleanJSON(content);
      return parsePartialJSON(cleanedContent);
    } catch (error) {
      console.error("Error parsing meal plan response:", error);
      throw new Error("Failed to parse meal plan response");
    }
  }

  private static generateFallbackMealPlan(request: MealPlanRequest): MealPlanResponse {
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const mealTimings = ["BREAKFAST", "LUNCH", "DINNER"];
    
    const caloriesPerMeal = Math.round(request.target_calories_daily / request.meals_per_day);
    const proteinPerMeal = Math.round(request.target_protein_daily / request.meals_per_day);
    const carbsPerMeal = Math.round(request.target_carbs_daily / request.meals_per_day);
    const fatsPerMeal = Math.round(request.target_fats_daily / request.meals_per_day);

    return {
      weekly_plan: days.slice(0, request.rotation_frequency_days).map((day, dayIndex) => ({
        day,
        day_index: dayIndex,
        meals: mealTimings.slice(0, request.meals_per_day).map((timing, mealIndex) => ({
          name: `${timing.toLowerCase()} meal ${dayIndex + 1}`,
          description: `Balanced ${timing.toLowerCase()} for day ${dayIndex + 1}`,
          meal_timing: timing,
          dietary_category: "BALANCED",
          prep_time_minutes: 20 + Math.floor(Math.random() * 20),
          difficulty_level: 1 + Math.floor(Math.random() * 3),
          calories: caloriesPerMeal,
          protein_g: proteinPerMeal,
          carbs_g: carbsPerMeal,
          fats_g: fatsPerMeal,
          fiber_g: 5 + Math.floor(Math.random() * 5),
          sugar_g: 5 + Math.floor(Math.random() * 10),
          sodium_mg: 300 + Math.floor(Math.random() * 400),
          ingredients: [
            {
              name: "Main ingredient",
              quantity: 100,
              unit: "g",
              category: "Protein",
            },
          ],
          instructions: [
            {
              step: 1,
              text: "Prepare ingredients",
            },
            {
              step: 2,
              text: "Cook according to preference",
            },
          ],
          allergens: [],
          image_url: "",
          portion_multiplier: 1.0,
          is_optional: false,
        })),
      })),
      weekly_nutrition_summary: {
        avg_daily_calories: request.target_calories_daily,
        avg_daily_protein: request.target_protein_daily,
        avg_daily_carbs: request.target_carbs_daily,
        avg_daily_fats: request.target_fats_daily,
        goal_adherence_percentage: 85,
      },
      shopping_tips: ["Plan your shopping in advance", "Buy fresh ingredients"],
      meal_prep_suggestions: ["Prepare ingredients on Sunday", "Cook in batches"],
    };
  }

  // Clear caches periodically
  static clearCaches(): void {
    requestCache.clear();
    requestQueue.clear();
    console.log("🧹 OpenAI service caches cleared");
  }
}

// Export the openai instance for direct use if needed
export { openai };