import express from 'express'
import { supabaseAdmin, supabase } from '../dbconnect.js'
import { authAdminMiddleware, authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { signupUserSchema, signupBusinessSchema, loginSchema, adminCreateUserSchema, adminCreateComppedBusinessSchema, adminCreateComppedUserSchema } from '../schemas/authSchemas.js'
import { catchAsync } from '../helpers/catchAsync.js';
import { AppError } from '../helpers/AppError.js';
import { authLimiter } from '../middleware/rateLimiter.js'

const router = express.Router()

router.get('/', (req, res) => {
    console.log("Got Auth route");
    res.send("Authentication Route");
})

router.post('/signup/user', authLimiter, validate(signupUserSchema), catchAsync(async (req, res) => {
    const { firstname, lastname, email, password, phone } = req.validated.body;
    const accountType = 'user';

    const {data, error} = await supabase.auth.signUp({
        email: email,
        password: password,
        options: {
            data: {
                firstname: firstname,
                lastname: lastname
            }
        }
    });

    if(error){
        throw new AppError(error.message, 500);
    }

    const {data: userData, error: userError} = await supabaseAdmin.from('users').insert({user_id: data.user.id, first_name: firstname, last_name: lastname, email: email, phone: phone, account_type: accountType}).select();
    
    if(userError){
        throw new AppError(userError.message, 500);
    }

    res.status(201).json({ success: true, message: 'Account successfully created' });
}))

router.post('/admin/create-user/:account_type', authMiddleware, authAdminMiddleware, validate(adminCreateUserSchema), catchAsync(async (req, res) => {
    const { firstname, lastname, email, password, phone } = req.validated.body;
    const { account_type: accountType } = req.validated.params;

    const {data, error} = await supabaseAdmin.auth.admin.createUser({
        email: email,
        phone: phone,
        password: password,
        email_confirm: true,
        user_metadata: { firstname: firstname, lastname: lastname }
    });

    if(error){
        throw new AppError(error.message, 500);
    }

    const {data: userData, error: userError} = await supabaseAdmin.from('users').insert({user_id: data.user.id, first_name: firstname, last_name: lastname, email: email, phone: phone, account_type: accountType}).select();
    

    if(userError){
        throw new AppError(userError.message, 500);
    }

    res.status(201).json({ success: true, message: 'User succesfully created' });
}))

// router.post('/admin/create-comped-user', authMiddleware, authAdminMiddleware, validate(adminCreateComppedUserSchema), catchAsync(async (req, res) => {
//     const { firstname, lastname, email, password, phone, is_premium } = req.validated.body;

//     const {data, error} = await supabaseAdmin.auth.admin.createUser({
//         email: email,
//         phone: phone,
//         password: password,
//         email_confirm: true,
//         user_metadata: { firstname: firstname, lastname: lastname }
//     });

//     if(error){
//         throw new AppError(error.message, 500);
//     }

//     const {data: userData, error: userError} = await supabaseAdmin.from('users').insert({
//         user_id: data.user.id,
//         first_name: firstname,
//         last_name: lastname,
//         email: email,
//         phone: phone,
//         account_type: 'user',
//         is_premium: is_premium,
//         is_comped: true
//     }).select();

//     if(userError){
//         throw new AppError(userError.message, 500);
//     }

//     res.status(201).json({ success: true, message: 'Comped user account created' });
// }))

// router.post('/admin/create-comped-business', authMiddleware, authAdminMiddleware, validate(adminCreateComppedBusinessSchema), catchAsync(async (req, res) => {
//     const { name: businessname, description: businessdescription, address: businessaddress, email: businessemail, phone: businessphone, state, city, zip, firstname, lastname, password, business_tier } = req.validated.body;

//     const slug = businessname.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

//     const {data, error} = await supabaseAdmin.auth.admin.createUser({
//         email: businessemail,
//         password: password,
//         email_confirm: true,
//         user_metadata: { firstname: firstname, lastname: lastname }
//     });

//     if(error){
//         throw new AppError(error.message, 500);
//     }

//     const {data: userData, error: userError} = await supabaseAdmin.from('users').insert({
//         user_id: data.user.id,
//         first_name: firstname,
//         last_name: lastname,
//         phone: businessphone,
//         email: businessemail,
//         account_type: 'business'
//     }).select();

//     if(userError){
//         throw new AppError(userError.message, 500);
//     }

//     const {data: businessData, error: businessError} = await supabaseAdmin.from('businesses').insert({
//         owner_user_id: data.user.id,
//         name: businessname,
//         description: businessdescription,
//         address: businessaddress,
//         city: city,
//         state: state,
//         zip: zip,
//         phone: businessphone,
//         email: businessemail,
//         slug: slug,
//         business_tier: business_tier,
//         is_comped: true
//     }).select();

//     if(businessError){
//         throw new AppError(businessError.message, 500);
//     }

//     return res.status(201).json({ success: true, message: 'Comped business account created' });
// }))

router.post('/signup/business', authLimiter, validate(signupBusinessSchema), catchAsync(async (req, res) => {
    const { name: businessname, description: businessdescription, address: businessaddress, email: businessemail, phone: businessphone, state, city, zip, firstname, lastname, password } = req.validated.body;

    const slug = businessname.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    const {data, error} = await supabase.auth.signUp({
        email: businessemail,
        password: password,
        options: {
            data: {
                firstname: firstname,
                lastname: lastname
            }
        }
    });

    if(error){
        throw new AppError(error.message, 500);
    }

    const {data: userData, error: userError} = await supabaseAdmin.from('users').insert({user_id: data.user.id, first_name: firstname, last_name: lastname, phone: businessphone, email: businessemail, account_type: 'business'}).select();

    if(userError){
        throw new AppError(userError.message, 500);
    }

    const {data: businessData, error: businessError} = await supabaseAdmin.from('businesses').insert({owner_user_id: data.user.id, name: businessname, description: businessdescription, address: businessaddress, city: city, state: state, zip: zip, phone: businessphone, email: businessemail, slug: slug}).select();

    if(businessError){
        throw new AppError(businessError.message, 500);
    }

    return res.status(201).json({ success: true, message: 'User and Business account successfully created' });
}))

router.post('/login', authLimiter, validate(loginSchema), catchAsync(async (req, res) => {
    const { email, password } = req.validated.body;

    const {data, error} = await supabase.auth.signInWithPassword({email: email, password: password});

    if(error){
        throw new AppError(error.message, 401);
    }

    const {data: userData, error: userError} = await supabaseAdmin.from('users').select('account_type').eq('user_id', data.user.id).single();

    if(userError){
        throw new AppError(userError.message, 500);
    }

    return res.status(200).json({
        success: true,
        data: {
            access_token: data.session.access_token,
            user_id: data.user.id,
            email: data.user.email,
            accountType: userData.account_type
        }
    });
}))

router.post('/logout', authMiddleware, catchAsync(async (req, res) => {

    const {error} = await supabase.auth.signOut();

    if(error){
        throw new AppError(error.message, 500);
    }

    return res.status(200).json({ success: true, message: 'User successfully signed out' });
}))
export default router