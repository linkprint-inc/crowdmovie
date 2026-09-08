-- Match the English, Japanese and Spanish homepage synopsis to the concise
-- audience-facing Chinese copy introduced in 0016. Internal generation rules
-- remain in the active movie bible and are intentionally not repeated here.

UPDATE "movies"
SET "synopsis_i18n" = "synopsis_i18n" || jsonb_build_object(
      'en', 'Now it’s your turn to direct: choose iconic figures from movies, games, animation, comics, history, and art—or create characters of your own. Decide who appears, where they meet, how they clash, and which signature moves they unleash. Write the next shot and vote for the stories you love, giving your idea a chance to become the next movie clip on screen.',
      'ja', '今度はあなたが監督です。映画、ゲーム、アニメ、漫画、歴史、美術の名高い人物を選ぶことも、自分だけのキャラクターを生み出すこともできます。誰を登場させ、どこで出会わせ、どう戦わせ、どんな技を繰り出すかを決めてください。次のショットを書き、気に入った展開に投票すれば、あなたのアイデアが次に上映される映画の一場面になるかもしれません。',
      'es', 'Ahora te toca dirigir: elige personajes icónicos del cine, los videojuegos, la animación, los cómics, la historia y el arte, o crea tus propios personajes. Decide quién aparece, dónde se encuentran, cómo se enfrentan y qué movimientos especiales desatan. Escribe el siguiente plano y vota por las historias que más te gusten para que tu idea tenga la oportunidad de convertirse en el próximo fragmento de la película que se proyecte.'
    ),
    "updated_at" = now()
WHERE "id" = '10000000-0000-4000-8000-000000000002';
--> statement-breakpoint
