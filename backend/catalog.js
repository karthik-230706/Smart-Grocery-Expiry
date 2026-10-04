// Barcode -> product lookup, used to auto-fill the Add Item form for the
// sales executive role. Barcodes are the real ones from the uploaded
// smartshelf/backend/data.json and dataset/products.csv (Blue-Smart).

const CATALOG = [
  { barcode: "8901063011122", name: "Parle-G Biscuits", brand: "Parle", category: "Biscuits", price: 30 },
  { barcode: "8901058851459", name: "Amul Toned Milk 1L", brand: "Amul", category: "Dairy", price: 64 },
  { barcode: "8901030823388", name: "Britannia Bread", brand: "Britannia", category: "Bakery", price: 45 },
  { barcode: "8901491101275", name: "Real Mixed Fruit Juice 1L", brand: "Real", category: "Beverages", price: 120 },
  { barcode: "8901719104162", name: "India Gate Basmati Rice 5kg", brand: "India Gate", category: "Staples", price: 550 },
  { barcode: "8900000000001", name: "Amul Taaza Toned Milk 500ml", brand: "Amul", category: "Dairy", price: 32 },
  { barcode: "8900000000002", name: "Amul Butter 500g", brand: "Amul", category: "Dairy", price: 265 },
  { barcode: "8900000000003", name: "Amul Curd 400g", brand: "Amul", category: "Dairy", price: 40 },
  { barcode: "8900000000004", name: "Mother Dairy Milk 500ml", brand: "Mother Dairy", category: "Dairy", price: 30 },
  { barcode: "8900000000005", name: "Britannia Good Day Biscuits", brand: "Britannia", category: "Biscuits", price: 35 },
  { barcode: "8900000000009", name: "Tata Salt 1kg", brand: "Tata", category: "Staples", price: 28 },
  { barcode: "8900000000011", name: "Fortune Sunflower Oil 1L", brand: "Fortune", category: "Cooking Oil", price: 165 },
  { barcode: "8900000000014", name: "Maggi 2-Minute Noodles", brand: "Nestle", category: "Instant Food", price: 14 },
  { barcode: "8900000000016", name: "Kellogg's Corn Flakes", brand: "Kellogg's", category: "Breakfast", price: 245 },
  { barcode: "8900000000021", name: "Tropicana Orange Juice", brand: "Tropicana", category: "Beverages", price: 110 },
  { barcode: "8900000000025", name: "Lay's Classic Salted Chips", brand: "Lay's", category: "Snacks", price: 20 },
  { barcode: "8900000000030", name: "Cadbury Dairy Milk", brand: "Cadbury", category: "Confectionery", price: 80 },
  { barcode: "8900000000022", name: "Dabur Honey 500g", brand: "Dabur", category: "Spreads", price: 210 },
  { barcode: "8900000000024", name: "Haldiram's Bhujia", brand: "Haldiram's", category: "Snacks", price: 55 },
  { barcode: "8900000000031", name: "Fresh Bananas 1kg", brand: "Farm Fresh", category: "Fruits", price: 50 },
  { barcode: "8900000000032", name: "Apples (Shimla) 1kg", brand: "Farm Fresh", category: "Fruits", price: 180 },
  { barcode: "8900000000033", name: "Mangoes (Alphonso) 1kg", brand: "Farm Fresh", category: "Fruits", price: 220 },
  { barcode: "8900000000034", name: "Oranges 1kg", brand: "Farm Fresh", category: "Fruits", price: 90 },
  { barcode: "8900000000035", name: "Grapes (Green) 500g", brand: "Farm Fresh", category: "Fruits", price: 70 },
  { barcode: "8900000000036", name: "Tomatoes 1kg", brand: "Farm Fresh", category: "Vegetables", price: 40 },
  { barcode: "8900000000037", name: "Onions 1kg", brand: "Farm Fresh", category: "Vegetables", price: 35 },
  { barcode: "8900000000038", name: "Potatoes 1kg", brand: "Farm Fresh", category: "Vegetables", price: 30 },
  { barcode: "8900000000039", name: "Spinach (Palak) 500g", brand: "Farm Fresh", category: "Vegetables", price: 25 },
  { barcode: "8900000000040", name: "Carrots 1kg", brand: "Farm Fresh", category: "Vegetables", price: 45 },
  { barcode: "8900000000041", name: "Capsicum 500g", brand: "Farm Fresh", category: "Vegetables", price: 40 },
];

const CATEGORY_LIST = [
  "Fruits", "Vegetables", "Dairy", "Bakery", "Staples", "Beverages", "Biscuits", "Cooking Oil",
  "Instant Food", "Breakfast", "Snacks", "Confectionery", "Spreads", "Other",
];

function lookupBarcode(code) {
  return CATALOG.find((p) => p.barcode === String(code).trim()) || null;
}

module.exports = { CATALOG, CATEGORY_LIST, lookupBarcode };
