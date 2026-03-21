const BOOK_GENRES = [
  'Art & Design',
  'Biography',
  'Business',
  'Children's Books',
  'Coding & Programming',
  'Comics & Graphic Novels',
  'Cooking & Food',
  'Crafts & Hobbies',
  'Creativity',
  'Education',
  'Entrepreneurship',
  'Fantasy',
  'Fiction',
  'Finance',
  'Freelancing',
  'Health & Fitness',
  'History',
  'Horror',
  'Language Learning',
  'Leadership',
  'Lifestyle',
  'Marketing',
  'Memoir',
  'Mindset & Motivation',
  'Mystery',
  'Parenting & Family',
  'Personal Development',
  'Philosophy',
  'Poetry',
  'Politics',
  'Productivity',
  'Psychology',
  'Religion & Spirituality',
  'Romance',
  'Sales',
  'Science',
  'Science Fiction',
  'Self-Help',
  'Social Media',
  'Technology',
  'Thriller',
  'Travel',
  'Wellness',
  'Women's Interests',
  'Writing'
].sort((a, b) => a.localeCompare(b));

const GENRE_ALIASES = {
  'self development': 'Personal Development',
  'self-development': 'Personal Development',
  'personal development': 'Personal Development',
  'personal growth': 'Personal Development',
  'self help': 'Self-Help',
  'self-help': 'Self-Help',
  'fiction': 'Fiction',
  'sci fi': 'Science Fiction',
  'sci-fi': 'Science Fiction',
  'science fiction': 'Science Fiction',
  'mystery': 'Mystery',
  'thriller': 'Thriller',
  'romance': 'Romance',
  'business': 'Business',
  'finance': 'Finance',
  'marketing': 'Marketing',
  'productivity': 'Productivity',
  'technology': 'Technology',
  'health': 'Health & Fitness',
  'health and fitness': 'Health & Fitness',
  'psychology': 'Psychology',
  'education': 'Education',
  'travel': 'Travel',
  'cooking': 'Cooking & Food',
  'history': 'History',
  'biography': 'Biography',
  'memoir': 'Memoir',
  'poetry': 'Poetry',
  'writing': 'Writing',
  'coding': 'Coding & Programming',
  'programming': 'Coding & Programming'
};

function normalizeGenre(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const lowered = raw.toLowerCase();
  if (GENRE_ALIASES[lowered]) return GENRE_ALIASES[lowered];
  const direct = BOOK_GENRES.find((genre) => genre.toLowerCase() == lowered);
  return direct || '';
}

module.exports = { BOOK_GENRES, normalizeGenre };
