import express from 'express'
import businessRouter from './routes/businesses.js'
import userRouter from './routes/users.js'
import categoryRouter from './routes/categories.js'
import serviceRouter from './routes/services.js'
import searchRouter from './routes/search.js'
import authRouter from './routes/auth.js'
import favoriteRouter from './routes/favorites.js'
import adminRouter from './routes/admin.js'
import landingRouter from './routes/signups.js'
import stripeRouter from './routes/stripe.js'
import cors from 'cors'
import { errorHandler } from './middleware/errorHandler.js'
import { generalLimiter } from './middleware/rateLimiter.js'
import helmet from 'helmet'
import stripeWebhookRouter from './routes/stripeWebhook.js'

const app = express()
app.set('trust proxy', 1)
app.use(cors())
app.use(generalLimiter)
app.use(helmet())

app.use('/stripe/webhook', stripeWebhookRouter)

app.use(express.json())

app.get('/', (req, res) => {
    res.send('Check Local First API');
})

app.use('/businesses', businessRouter)
app.use('/users', userRouter)
app.use('/services', serviceRouter)
app.use('/categories', categoryRouter)
app.use('/search', searchRouter)
app.use('/auth', authRouter)
app.use('/favorites', favoriteRouter)
app.use('/admin', adminRouter)
app.use('/landing', landingRouter)
app.use('/stripe', stripeRouter)

app.use((req, res, next) => {
    next(new AppError(`Route not found: ${req.originalUrl}`, 404));
});

app.use(errorHandler)


app.listen(3000, () => {
    console.log("Server running on port 3000");
})